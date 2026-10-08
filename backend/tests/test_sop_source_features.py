"""Features C (SOP source-context injection into scoring) and D (opt-in SOP coverage check).

C is default-on prompt enrichment: the full text of every SOP section the rubric cites, and the
approved summaries of the cited documents, are added to the judging prompt
(spec-sop-section-grounding §3). It must NOT change the score for a given set of judgments —
the pure engine never sees it. D is an opt-in advisory audit: off by default (no extra LLM call, no
report field), on it appends "SOP points the rubric may not cover" to the report WITHOUT touching a
single score.

All paths run on the deterministic mock LLM (SPEC P2) — no Azure.
"""

import json

import pytest

from app.interview import state_machine
from app.interview.scoring_engine import RubricItem
from app.models.sop import SopChunk, SopDocument, SopSection
from app.services import checklist_service, question_service, scoring_service, sop_coverage
from app.services.anonymous_session_service import create_anonymous_session
from app.services.sop_citation import CitedSection


async def _doc_with_sections(db, sections: list[tuple[str, str]], *, name="sop.txt") -> str:
    """Persist an SOP document split into the given ``(number, text)`` top-level sections."""
    doc = SopDocument(
        name=name, status="chunked", size=sum(len(t) for _, t in sections), markdown_source="text"
    )
    db.add(doc)
    await db.flush()
    for i, (number, text) in enumerate(sections):
        db.add(
            SopSection(
                document_id=doc.id,
                order_index=i,
                number=number,
                title=f"Clause {number}",
                text=text,
            )
        )
        db.add(
            SopChunk(
                document_id=doc.id, chunk_index=i, content=text, page_label="p.1", token_count=5
            )
        )
    await db.commit()
    return doc.id


def _cites(doc_id: str, *sections: str) -> str:
    return json.dumps([{"document_id": doc_id, "section": n} for n in sections])


async def _question_with_sourced_checklist(db, *, text="Describe the safety procedure."):
    """A question whose checklist items link a real SOP document (so C/D have text to read)."""
    bank = await question_service.create_bank(db, name="B", is_default=True)
    q = await question_service.add_question(
        db, bank_id=bank.id, text=text, order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db, q.id)  # mock drafts a 3-item checklist
    doc_id = await _doc_with_sections(
        db,
        [
            (
                "1",
                "Always verify the guard is engaged before starting. Log the result and never "
                "bypass the safety check under any circumstances.",
            )
        ],
    )
    checklist = await checklist_service.get_default_checklist(db, q.id)
    items = await checklist_service.list_items(db, checklist.id)
    for it in items:
        it.source_document_id = doc_id
        it.source_refs = _cites(doc_id, "1")
    await db.commit()
    return q


# --- C: prompt enrichment, no score impact ---------------------------------


def test_build_prompt_carries_each_cited_section_once_and_the_approved_summaries():
    rubric = [
        RubricItem(item_id="i1", kind="required", text="Do the thing", weight=50),
        RubricItem(item_id="i2", kind="required", text="Do the other", weight=50),
    ]
    section = CitedSection("d1", "Widget SOP.pdf", "4.2", "Release", 5, 7, "4.2 Release\nFULL TEXT")
    sources = scoring_service.ScoringSources(
        sections=(section,),
        item_sections={"i1": (0,), "i2": (0,)},
        summaries=(("Widget SOP.pdf", "**Purpose:** Release widgets."),),
    )
    without = scoring_service._build_scoring_prompt("Q?", "A", rubric)
    withctx = scoring_service._build_scoring_prompt("Q?", "A", rubric, sources)
    assert "SOP SECTIONS" not in without and "SUMMARIES" not in without
    assert withctx.count("FULL TEXT") == 1  # cited twice, sent once
    assert "[1] (required) Do the thing  — cites [S1]" in withctx
    assert "[S1] Widget SOP.pdf — 4.2 Release (pp. 5-7)" in withctx
    assert "**Purpose:** Release widgets." in withctx


@pytest.mark.asyncio
async def test_source_context_does_not_change_score(db_session):
    q = await _question_with_sourced_checklist(db_session)
    answer = "I followed the documented steps in order and explained my reasoning clearly."
    with_ctx = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text=answer,
        include_source_context=True,
    )
    without_ctx = await scoring_service.score_answer_against_checklist(
        db_session,
        question_id=q.id,
        question_text=q.text,
        answer_text=answer,
        include_source_context=False,
    )
    # Same deterministic judgments → identical score, regardless of the prompt enrichment.
    assert with_ctx is not None and without_ctx is not None
    assert with_ctx.score == without_ctx.score


@pytest.mark.asyncio
async def test_source_context_collected_for_sourced_items(db_session):
    q = await _question_with_sourced_checklist(db_session)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    rubric = [
        RubricItem(
            item_id=it.id,
            kind=it.kind,
            text=it.text,
            weight=it.weight,
            source_document_id=it.source_document_id,
            source_refs=tuple(json.loads(it.source_refs)),
        )
        for it in items
    ]
    sources = await scoring_service.collect_sources(db_session, rubric)
    assert len(sources.sections) == 1  # every item cites the same section: once
    assert "verify the guard" in sources.sections[0].text
    assert set(sources.item_sections) == {it.id for it in items}
    assert sources.summaries == ()  # no summary approved yet


# --- D: opt-in, advisory, never affects a score ----------------------------


async def _run_interview(db):
    await _question_with_sourced_checklist(db)
    cand, _ = await create_anonymous_session(db, ip_address="1.2.3.4")
    interview = await state_machine.start_interview(db, cand.id)
    interview = await state_machine.answer_finalized(
        db, interview, "I followed each documented step and checked safety.", source="text"
    )
    assert interview.status == "completed"
    return interview


@pytest.mark.asyncio
async def test_coverage_check_off_by_default(db_session, monkeypatch):
    interview = await _run_interview(db_session)
    # Fail loudly if the coverage service is called when the flag is off.
    called = False

    async def _boom(*args, **kwargs):
        nonlocal called
        called = True
        return []

    # Patch what the REPORT PATH actually touches first. This used to patch
    # `check_question_coverage`, which the report path stopped calling when the audit was split into
    # prepare/audit halves — so the assertion below was passing vacuously, protecting nothing.
    monkeypatch.setattr(sop_coverage, "prepare_coverage", _boom)
    report = await state_machine.score_and_finalize(db_session, interview)
    assert report["sop_coverage"] is None
    assert called is False  # no coverage work at all when opted out — not even a DB read


@pytest.mark.asyncio
async def test_coverage_check_on_appends_findings_without_changing_scores(db_session):
    # Score once WITHOUT the check to capture the baseline per-question scores.
    interview = await _run_interview(db_session)
    baseline = await state_machine.score_and_finalize(db_session, interview)
    baseline_scores = {e["question_id"]: e.get("score") for e in baseline["per_question"]}

    # Fresh interview, same question set, WITH the check on.
    cand, _ = await create_anonymous_session(db_session, ip_address="5.6.7.8")
    iv2 = await state_machine.start_interview(db_session, cand.id)
    iv2 = await state_machine.answer_finalized(
        db_session, iv2, "I followed each documented step and checked safety.", source="text"
    )
    with_check = await state_machine.score_and_finalize(db_session, iv2, sop_coverage_check=True)

    # Findings are attached (mock returns one uncovered point), grouped per question.
    assert with_check["sop_coverage"]
    group = with_check["sop_coverage"][0]
    assert group["missing"] and group["missing"][0]["point"]

    # And every per-question score is identical to the opt-out run — D never touches a score.
    with_scores = {e["question_id"]: e.get("score") for e in with_check["per_question"]}
    assert with_scores == baseline_scores
    assert with_check["total_score"] == baseline["total_score"]


@pytest.mark.asyncio
async def test_coverage_returns_empty_without_sourced_checklist(db_session):
    # A checklist whose items link NO source document → nothing to audit → [].
    bank = await question_service.create_bank(db_session, name="B", is_default=True)
    q = await question_service.add_question(db_session, bank_id=bank.id, text="Q?", order_index=0)
    await checklist_service.draft_checklist(db_session, q.id)
    missing = await sop_coverage.check_question_coverage(
        db_session, question_id=q.id, question_text="Q?"
    )
    assert missing == []


# --- D: the audit's own progress + concurrency (v0.45.0.0) -----------------


AUDITABLE = 4


async def _bank_with_mixed_checklists(db) -> tuple[list[str], list[str]]:
    """One default bank: ``AUDITABLE`` questions whose checklist items link a real SOP document,
    plus one whose do not. Only the sourced ones can cost an audit call.

    Four rather than two so "every question goes at once" is a claim worth making: with two, a peak
    of 2 is also what a hard-coded pair would produce.
    """
    bank = await question_service.create_bank(db, name="Mixed", is_default=True)
    doc_id = await _doc_with_sections(
        db, [("1", "Always verify the guard is engaged before starting. Never bypass the check.")]
    )
    sourced: list[str] = []
    unsourced: list[str] = []
    for i in range(AUDITABLE + 1):
        q = await question_service.add_question(
            db,
            bank_id=bank.id,
            text=f"Describe step {i}?",
            order_index=i,
            expected_points=json.dumps([]),
        )
        await checklist_service.draft_checklist(db, q.id)
        if i < AUDITABLE:
            checklist = await checklist_service.get_default_checklist(db, q.id)
            for it in await checklist_service.list_items(db, checklist.id):
                it.source_document_id = doc_id
                it.source_refs = _cites(doc_id, "1")
            sourced.append(q.id)
        else:
            unsourced.append(q.id)
    await db.commit()
    return sourced, unsourced


async def _answer_until_complete(db, interview, answer: str = "I followed each documented step."):
    while interview.status == "in_progress":
        interview = await state_machine.answer_finalized(db, interview, answer, source="text")
    return interview


async def _collect(db, interview, **kwargs) -> list[dict]:
    return [e async for e in state_machine.score_and_finalize_events(db, interview, **kwargs)]


@pytest.mark.asyncio
async def test_coverage_emits_progress_counting_only_the_calls_it_will_make(db_session):
    """The audit reports its OWN progress, and its denominator is the number of model round-trips.

    Before v0.45.0.0 the audit emitted nothing at all: after the last "N of N scored" line the
    candidate watched a frozen spinner for the whole audit. And a naive denominator would be the
    question count — wrong, because a question with no linked SOP passage has nothing to audit and
    costs no call, so the bar would stall short of its total forever.
    """
    sourced, unsourced = await _bank_with_mixed_checklists(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="9.9.9.9")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)

    events = await _collect(db_session, interview, sop_coverage_check=True)
    coverage = [e for e in events if e["type"] == "coverage"]

    # One opening event (done=0) plus one per audited question, and the denominator is 2 — the
    # sourced questions only, NOT all three.
    assert coverage, "the audit must report progress"
    assert {e["total"] for e in coverage} == {len(sourced)} == {AUDITABLE}
    assert coverage[0]["done"] == 0
    assert coverage[-1]["done"] == len(sourced)
    audited = {e["question_id"] for e in coverage if "question_id" in e}
    assert audited == set(sourced)
    assert not (audited & set(unsourced))

    # The report still lands last, and the audit is attached.
    assert events[-1]["type"] == "report"
    assert events[-1]["report"]["sop_coverage"]


@pytest.mark.asyncio
async def test_every_coverage_audit_is_in_flight_at_once(db_session, monkeypatch):
    """ALL N audits are dispatched together, not merely "more than one at a time".

    They used to be strictly serial, on a comment's wrong claim that the check was "another DB
    call" — it ends in an LLM round-trip. `SCORING_CONCURRENCY_DIVISOR` defaults to 1, so
    `scoring_concurrency(N) == N`: this asserts the peak equals the task count, which is what
    pins "N in parallel" rather than "some overlap happened".
    """
    import asyncio

    in_flight = 0
    peak = 0
    real = sop_coverage.audit_prepared

    async def _tracked(task, **kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await asyncio.sleep(0.05)  # long enough that serial execution cannot overlap
            return await real(task, **kwargs)
        finally:
            in_flight -= 1

    monkeypatch.setattr(sop_coverage, "audit_prepared", _tracked)

    await _bank_with_mixed_checklists(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="9.9.9.8")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)

    await _collect(db_session, interview, sop_coverage_check=True)
    assert peak == AUDITABLE, f"expected all {AUDITABLE} audits in flight at once, peaked at {peak}"


@pytest.mark.asyncio
async def test_a_failing_audit_never_costs_the_report(db_session, monkeypatch):
    """An advisory audit that blows up loses its findings and nothing else.

    The audit is reference-only and never touches a score, so it must not be the reason a candidate
    loses a report they have already earned.
    """

    async def _explode(*args, **kwargs):
        raise RuntimeError("model is down")

    monkeypatch.setattr(sop_coverage, "audit_prepared", _explode)

    await _bank_with_mixed_checklists(db_session)
    cand, _ = await create_anonymous_session(db_session, ip_address="9.9.9.7")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)

    events = await _collect(db_session, interview, sop_coverage_check=True)
    report = events[-1]
    assert report["type"] == "report"
    assert report["report"]["sop_coverage"] is None  # no findings survived
    assert report["report"]["per_question"]  # but the scored report did
    assert report["report"]["status"] == "scored"


# --- D: which SOP text the audit actually reads (v0.45.0.0) ----------------


@pytest.mark.asyncio
async def test_the_audit_reads_every_cited_section_and_nothing_uncited(db_session):
    """Each item's own cited sections, from every cited document, and no other text: item 1 cites
    document A §1, item 2 cites document B §2. A's §9 is an appendix nobody cited."""
    bank = await question_service.create_bank(db_session, name="Multi", is_default=True)
    q = await question_service.add_question(
        db_session, bank_id=bank.id, text="Q?", order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db_session, q.id)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    assert len(items) >= 2, "fixture needs two items to cite two documents"

    doc_a = await _doc_with_sections(
        db_session,
        [
            ("1", "ALPHA-ONE: always verify the guard is engaged before starting."),
            ("9", "ALPHA-NINE: an appendix no checklist item cited."),
        ],
    )
    doc_b = await _doc_with_sections(
        db_session, [("2", "BRAVO-TWO: escalate country-level divergence to the regional lead.")]
    )
    items[0].source_refs = _cites(doc_a, "1")
    items[1].source_refs = _cites(doc_b, "2")
    await db_session.commit()

    task = await sop_coverage.prepare_coverage(db_session, question_id=q.id, question_text="Q?")
    assert task is not None
    assert "ALPHA-ONE" in task.prompt and "BRAVO-TWO" in task.prompt
    assert "ALPHA-NINE" not in task.prompt


@pytest.mark.asyncio
async def test_cited_sections_are_never_cut(db_session):
    """Owner, 2026-10-08: the full cited section, never a slice. Long sections arrive whole."""
    bank = await question_service.create_bank(db_session, name="Many", is_default=True)
    q = await question_service.add_question(
        db_session, bank_id=bank.id, text="Q?", order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db_session, q.id)
    checklist = await checklist_service.get_default_checklist(db_session, q.id)
    items = await checklist_service.list_items(db_session, checklist.id)
    texts = [f"DOC{n} " + "x" * 5000 + f" END{n}" for n in range(len(items))]
    for it, text in zip(items, texts, strict=True):
        it.source_refs = _cites(await _doc_with_sections(db_session, [("1", text)]), "1")
    await db_session.commit()

    task = await sop_coverage.prepare_coverage(db_session, question_id=q.id, question_text="Q?")
    assert task is not None
    assert all(text in task.prompt for text in texts)


@pytest.mark.asyncio
async def test_audit_prepared_swallows_a_model_failure_on_its_own(db_session, monkeypatch):
    """The degrade contract belongs to ``audit_prepared`` itself, not only to its caller.

    `test_a_failing_audit_never_costs_the_report` patches `audit_prepared` away, so it proves the
    state machine's belt-and-braces catch and never executes the function's OWN try/except. This one
    breaks the model call underneath it instead.
    """

    async def _explode(*args, **kwargs):
        raise RuntimeError("model is down")

    monkeypatch.setattr(sop_coverage.scoring_service, "complete_with_retry", _explode)

    q = await _question_with_sourced_checklist(db_session)
    task = await sop_coverage.prepare_coverage(db_session, question_id=q.id, question_text=q.text)
    assert task is not None
    # No findings, no exception — a reference-only audit must never be the reason a report fails.
    assert await sop_coverage.audit_prepared(task) == []


@pytest.mark.asyncio
async def test_a_slow_audit_emits_heartbeats_so_the_stream_is_never_idle(db_session, monkeypatch):
    """The audit phase keeps the connection alive, the same way grading does.

    This is the half that was missing before v0.45.0.0: the audit ran with NO event on the wire at
    all, so an audit slower than the ingress idle timeout killed the report stream outright.
    """
    import asyncio

    real = sop_coverage.audit_prepared

    async def _slow(task, **kw):
        await asyncio.sleep(0.25)  # longer than the heartbeat interval below
        return await real(task, **kw)

    monkeypatch.setattr(sop_coverage, "audit_prepared", _slow)
    monkeypatch.setattr(state_machine, "SCORING_HEARTBEAT_SECONDS", 0.05)

    interview = await _run_interview(db_session)
    events = await _collect(db_session, interview, sop_coverage_check=True)

    pings = [e for e in events if e["type"] == "ping"]
    assert pings, "an audit slower than the heartbeat interval must emit keepalives"
    assert events[-1]["type"] == "report"


@pytest.mark.asyncio
async def test_a_question_with_no_auditable_source_costs_no_audit_events(db_session):
    """Opted in, but nothing to audit: no `coverage` events at all, and the report still lands.

    A checklist whose items link no SOP document yields no task, so the audit's denominator would be
    zero — the stream must simply not mention it rather than announce "0 of 0".
    """
    bank = await question_service.create_bank(db_session, name="Unsourced", is_default=True)
    q = await question_service.add_question(
        db_session, bank_id=bank.id, text="Q?", order_index=0, expected_points=json.dumps([])
    )
    await checklist_service.draft_checklist(db_session, q.id)  # a checklist, but no linked document
    cand, _ = await create_anonymous_session(db_session, ip_address="9.9.9.6")
    interview = await state_machine.start_interview(db_session, cand.id)
    interview = await _answer_until_complete(db_session, interview)

    events = await _collect(db_session, interview, sop_coverage_check=True)
    assert [e for e in events if e["type"] == "coverage"] == []
    assert events[-1]["type"] == "report"
    assert events[-1]["report"]["sop_coverage"] is None
    assert q.id
