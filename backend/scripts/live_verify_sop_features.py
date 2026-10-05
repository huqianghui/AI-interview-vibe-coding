"""Live-Azure verification for features C and D (SOP source-context + coverage check).

Run OUTSIDE pytest against the real Foundry LLM (DEFAULT_LLM_PROVIDER=azure). Uses a throwaway
in-memory SQLite DB seeded via the ORM — never touches ai_coach.db. Prints only the model NAME and
prompt/score shapes; no endpoint values or secrets.

Section E additionally proves every cited SOP document reaches the audit prompt (the multi-source
fix) and MEASURES one audit call's wall clock, which is the number
``SCORING_CALL_TIMEOUT_SECONDS`` has to be a safe multiple of.

Usage (from backend/, with .env + az login present):
    python -m scripts.live_verify_sop_features [--runs N]
"""

from __future__ import annotations

import argparse
import asyncio
import time

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.db import Base
from app.models.checklist import Checklist, ChecklistItem
from app.models.question import Question, QuestionBank
from app.models.sop import SopChunk, SopDocument
from app.services import scoring_service, sop_coverage
from app.services.agents.registry import get_llm_adapter

QUESTION_TEXT = "Describe the machine start-up safety procedure."

SOP_TEXT = (
    "Section 3 — Machine start-up safety. Before starting the line the operator MUST: "
    "(1) verify the physical guard is engaged and latched; "
    "(2) confirm the emergency-stop button is reachable and not obstructed; "
    "(3) check the lockout/tagout log shows no open maintenance ticket; "
    "(4) record the pre-start checklist result in the shift log. "
    "Under no circumstances may the safety interlock be bypassed, even temporarily, and any "
    "bypass attempt must be reported to the shift supervisor immediately."
)

# A SECOND document, cited by its own checklist item at its own page label. Its distinctive
# requirement (the counter-signature) is deliberately NOT in the checklist, so a finding that
# mentions it proves the live audit actually READ this document — which it could not do before
# v0.45.0.0, when only the first cited document was ever opened.
SOP_TEXT_2 = (
    "Work Instruction 7 — Shift handover. The outgoing operator MUST brief the incoming operator "
    "on any open maintenance ticket, and MUST obtain a counter-signature in the handover log "
    "before leaving the line. A handover recorded without a counter-signature is not valid and the "
    "line may not be started on it."
)

# A deliberately PARTIAL checklist: it covers the guard + not-bypassing + the handover briefing, but
# omits the emergency-stop reachability, the lockout/tagout log check, recording in the shift log
# (document 1) and the counter-signature (document 2) — so a real coverage audit (D) has genuine
# gaps to find in BOTH documents. Last field is which document the item cites (1 or 2).
CHECKLIST_ITEMS = [
    (
        "required",
        "Verify the physical guard is engaged before starting.",
        50,
        "verify the physical guard is engaged and latched",
        1,
    ),
    (
        "forbidden",
        "Never bypass the safety interlock.",
        30,
        "Under no circumstances may the safety interlock be bypassed",
        1,
    ),
    (
        "required",
        "Brief the incoming operator on any open maintenance ticket at handover.",
        20,
        "brief the incoming operator on any open maintenance ticket",
        2,
    ),
]

ANSWER = (
    "Before starting I check that the guard is engaged and latched, and I never bypass the "
    "safety interlock — if anything looks wrong I stop and call the supervisor."
)


async def _seed(db: AsyncSession) -> str:
    """Seed one bank/question + SOP doc/chunk + a 2-item sourced checklist; return question_id."""
    bank = QuestionBank(name="live-verify", is_default=True)
    db.add(bank)
    await db.flush()

    q = Question(bank_id=bank.id, text=QUESTION_TEXT, order_index=0, expected_points="[]")
    db.add(q)
    await db.flush()

    docs: dict[int, tuple[str, str]] = {}
    for n, (name, text, page) in enumerate(
        [("startup-sop.txt", SOP_TEXT, "p.3"), ("handover-wi.txt", SOP_TEXT_2, "p.7")], start=1
    ):
        doc = SopDocument(name=name, status="chunked", size=len(text))
        db.add(doc)
        await db.flush()
        db.add(
            SopChunk(
                document_id=doc.id,
                chunk_index=0,
                content=text,
                page_label=page,
                token_count=len(text) // 4,
            )
        )
        docs[n] = (doc.id, page)

    checklist = Checklist(question_id=q.id, prompt_version="live", is_default=True)
    db.add(checklist)
    await db.flush()
    for idx, (kind, text, weight, quote, doc_n) in enumerate(CHECKLIST_ITEMS):
        doc_id, page = docs[doc_n]
        db.add(
            ChecklistItem(
                checklist_id=checklist.id,
                kind=kind,
                text=text,
                weight=weight,
                source_quote=quote,
                source_document_id=doc_id,
                # Each item carries ITS OWN document's page — the pairing the old two-`next()`
                # lookup could get wrong.
                source_page=page,
                order_index=idx,
            )
        )
    await db.commit()
    return q.id


async def main(runs: int = 5) -> None:
    settings = get_settings()
    adapter = get_llm_adapter()  # resolves DEFAULT_LLM_PROVIDER
    provider = settings.default_llm_provider
    print("=" * 70)
    print("LIVE SOP FEATURE VERIFICATION (C + D)")
    print(f"  DEFAULT_LLM_PROVIDER = {provider}")
    print(f"  resolved adapter     = {type(adapter).__name__}")
    print(f"  model                = {getattr(settings, 'foundry_agent_model', '?')}")
    if type(adapter).__name__ == "MockLLMAdapter":
        raise SystemExit("ABORT: adapter degraded to mock — not a live run. Check .env / az login.")
    print("=" * 70)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(conn, _rec):  # noqa: ANN001
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with factory() as db:
        question_id = await _seed(db)

        # --- C: prove the fuller SOP passage is injected into the LIVE scoring prompt, and that
        #        turning it on/off does not change the live score. ---
        print("\n[C] SOP source-context injection into the scoring prompt")
        from app.interview.scoring_engine import RubricItem
        from app.services.checklist_service import get_default_checklist, list_items

        cl = await get_default_checklist(db, question_id)
        assert cl is not None, "seed failed: no default checklist"
        items = await list_items(db, cl.id)
        rubric = [
            RubricItem(
                item_id=it.id,
                kind=it.kind,
                text=it.text,
                weight=it.weight,
                source_quote=it.source_quote,
                source_page=it.source_page,
                source_document_id=it.source_document_id,
                advisory=it.advisory,
            )
            for it in items
        ]
        ctx = await scoring_service._collect_source_context(db, rubric)
        enriched = scoring_service._build_scoring_prompt(QUESTION_TEXT, ANSWER, rubric, ctx)
        plain = scoring_service._build_scoring_prompt(QUESTION_TEXT, ANSWER, rubric, None)
        assert "原文依据" in enriched and "原文依据" not in plain, "C: passage not injected"
        assert "emergency-stop" in enriched, "C: fuller SOP passage text missing from prompt"
        print(f"  source passages collected for {len(ctx)}/{len(rubric)} items")
        print(f"  enriched prompt is {len(enriched) - len(plain)} chars longer (the SOP passages)")

        res_on = await scoring_service.score_answer_against_checklist(
            db,
            question_id=question_id,
            question_text=QUESTION_TEXT,
            answer_text=ANSWER,
            include_source_context=True,
        )
        res_off = await scoring_service.score_answer_against_checklist(
            db,
            question_id=question_id,
            question_text=QUESTION_TEXT,
            answer_text=ANSWER,
            include_source_context=False,
        )
        assert res_on is not None and res_off is not None, "C: scoring returned None"
        print(f"  LIVE score  WITH context = {res_on.score}")
        print(f"  LIVE score WITHOUT context = {res_off.score}")
        # Scores come from the deterministic engine over the LLM judgments. They should match; if
        # the live model judged an item differently between the two calls we surface it rather than
        # hard-failing (that's model nondeterminism, not a C regression).
        if res_on.score == res_off.score:
            print("  ✅ C: identical score with/without source context (engine unaffected)")
        else:
            print(
                "  ⚠️  C: scores differ — likely live-model judgment nondeterminism, "
                "not an engine change. Re-run to confirm."
            )

        # --- D: run the real coverage audit and show it finds genuine gaps, without touching the
        #        score. ---
        print("\n[D] SOP original-text coverage check (opt-in, advisory)")
        missing = await sop_coverage.check_question_coverage(
            db, question_id=question_id, question_text=QUESTION_TEXT
        )
        print(f"  coverage findings returned: {len(missing)}")
        for i, m in enumerate(missing, 1):
            print(f"    {i}. point: {m['point']}")
            if m.get("sop_evidence"):
                print(f"       evidence: {m['sop_evidence']}")
        # Re-score after the audit and confirm the per-question score is unchanged by D.
        res_after = await scoring_service.score_answer_against_checklist(
            db,
            question_id=question_id,
            question_text=QUESTION_TEXT,
            answer_text=ANSWER,
            include_source_context=True,
        )
        assert res_after is not None, "D: scoring returned None"
        print(f"  LIVE score after coverage audit = {res_after.score} (audit never writes a score)")
        if missing:
            print("  ✅ D: live audit produced advisory findings (rubric gaps surfaced)")
        else:
            print(
                "  ⚠️  D: live audit returned no findings — the model judged the checklist "
                "complete for this SOP. Try a sparser checklist to force a gap."
            )

        # --- E: every cited document is read, each paired with its OWN page, and how long ONE
        #        audit call actually takes. ---
        print("\n[E] Multi-document sourcing + per-call latency")
        task = await sop_coverage.prepare_coverage(
            db, question_id=question_id, question_text=QUESTION_TEXT
        )
        assert task is not None, "E: prepare_coverage returned no task"
        # Distinctive spans from each document. Before v0.45.0.0 only the first cited document was
        # opened, and its passage could be narrowed by the OTHER item's page label.
        doc1_in = "lockout/tagout log" in task.prompt
        doc2_in = "counter-signature" in task.prompt
        print(f"  passage blocks in prompt : {task.prompt.count('--- SOP PASSAGE ')}")
        print(f"  document 1 text present  : {doc1_in}")
        print(f"  document 2 text present  : {doc2_in}")
        if doc1_in and doc2_in:
            print("  ✅ E: both cited documents reached the audit prompt")
        else:
            raise SystemExit("E: a cited document is missing from the audit prompt")

        latencies: list[float] = []
        for i in range(1, runs + 1):
            t0 = time.perf_counter()
            found = await sop_coverage.audit_prepared(task)
            dt = time.perf_counter() - t0
            latencies.append(dt)
            mentions_doc2 = any(
                "counter-sign" in (m.get("point", "") + m.get("sop_evidence", "")).lower()
                for m in found
            )
            print(
                f"  run {i}/{runs}: {dt:6.1f}s  findings={len(found):<2} "
                f"mentions document 2's gap={mentions_doc2}"
            )
        latencies.sort()
        mid = latencies[len(latencies) // 2]
        print(
            f"  per-call latency: min {latencies[0]:.1f}s  median {mid:.1f}s  "
            f"max {latencies[-1]:.1f}s  (n={len(latencies)}, sequential)"
        )
        print(
            f"  SCORING_CALL_TIMEOUT_SECONDS = "
            f"{scoring_service.SCORING_CALL_TIMEOUT_SECONDS:.0f}s "
            f"→ {scoring_service.SCORING_CALL_TIMEOUT_SECONDS / latencies[-1]:.1f}x the slowest "
            f"observed call"
        )

    await engine.dispose()
    print("\nDONE — live C/D/E verification complete.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--runs",
        type=int,
        default=5,
        help="How many sequential coverage-audit calls to time in section E (default 5).",
    )
    asyncio.run(main(runs=ap.parse_args().runs))
