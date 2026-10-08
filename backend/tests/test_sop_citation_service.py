"""Relocating a bank's SOP citations (spec-sop-section-grounding §4): labels resolved to their
sections, everything else found by search, nothing invented, results written to the DRAFT.

Synthetic SOP text only: this repo is public.
"""

import asyncio
import json

import pytest

from app.models.sop import CitationRun, SopDocument, SopSection
from app.services import checklist_service, question_service, sop_citation_service
from app.services.sop_citation_labels import DocumentName, expand_range, parse_label
from tests.conftest import ScriptedJudgeAdapter, _real_judge_adapter

pytestmark = pytest.mark.asyncio


async def _doc(db, name, sections) -> str:
    doc = SopDocument(name=name, status="chunked", markdown_source="text")
    db.add(doc)
    await db.flush()
    for i, (number, title, parent, text) in enumerate(sections):
        db.add(
            SopSection(
                document_id=doc.id,
                order_index=i,
                number=number,
                title=title,
                level=number.count(".") + 1,
                parent_index=parent,
                page_start=i + 1,
                page_end=i + 1,
                text=text,
            )
        )
    await db.commit()
    return doc.id


async def _corpus(db):
    widget = await _doc(
        db,
        "Widget Release Procedure.pdf",
        [
            ("4", "RELEASE", None, "Release follows these steps."),
            ("4.1", "Inspection", 0, "Every widget is inspected before it is packed."),
            ("4.2", "Approval", 0, "The Quality Manager signs the release form within 24 hours."),
            ("5", "ESCALATION", None, "A failed batch is escalated to the site lead the same day."),
        ],
    )
    jd = await _doc(
        db,
        "Release Manager_Final (1).docx",
        [("§1", "Responsibilities", None, "Owns the release calendar and the approval meetings.")],
    )
    return widget, jd


async def _bank(db, items):
    bank = await question_service.create_bank(db, name="Widgets", is_default=True)
    q = await question_service.add_question(
        db, bank_id=bank.id, text="How do you release a batch of widgets?", order_index=0
    )
    checklist = await checklist_service._persist_draft(
        db,
        q.id,
        checklist_service.ChecklistDraft(
            prompt_version="t",
            items=[
                checklist_service.DraftItem(
                    kind="required", text=text, weight=w, source_quote=quote
                )
                for text, w, quote in items
            ],
        ),
    )
    return bank, checklist.id


async def test_labels_name_documents_and_sections():
    docs = [
        DocumentName("a", "Widget Release Procedure.pdf"),
        DocumentName("b", "Release Manager_Final (1).docx"),
        DocumentName("c", "Senior Release Manager_Final (1).docx"),
    ]
    parts = parse_label(
        "Widget Release Procedure SOP sections 4.1, 4.2 and 5; Release Manager JD; Handbook", docs
    )
    assert [(p.document_id, p.exact, p.numbers) for p in parts] == [
        ("a", True, ["4.1", "4.2", "5"]),
        ("b", True, []),  # "Release Manager" covers the senior name only 2/3
        (None, False, []),
    ]
    # Both names fully covered: the longer one explains more of the label.
    (senior,) = parse_label("Senior Release Manager JD section 3", docs)
    assert (senior.document_id, senior.exact) == ("c", True)
    # A partial name narrows the search but its sections are not taken as given.
    (partial,) = parse_label("Senior Release section 3", docs)  # 2 of 3 name words
    assert (partial.document_id, partial.exact, partial.numbers) == ("c", False, ["3"])
    (rng,) = parse_label("Widget Release Procedure sections 5.1-5.3", docs)
    assert rng.ranges == [("5.1", "5.3")]
    assert expand_range("5.1", "5.3", ["5", "5.1", "5.1.1", "5.2", "§2", "5.3", "5.4"]) == [
        "5.1",
        "5.2",
        "5.3",
    ]


async def test_relocation_resolves_labels_searches_the_rest_and_never_invents(db_session):
    widget, jd = await _corpus(db_session)
    bank, checklist = await _bank(
        db_session,
        [
            ("Gets the Quality Manager's sign-off", 40, "Widget Release Procedure SOP section 4.2"),
            ("Escalates a failed batch the same day", 30, ""),
            ("Names the release owner", 20, "Release Manager JD"),
            ("Speaks with confidence", 10, "SOP Handbook"),
        ],
    )

    async def choose(prompt: str) -> str:
        item = prompt.split("RUBRIC ITEM:\n")[1].split("\n")[0]
        if "Quality Manager's sign-off" in item:  # label: fixed sections, quote it
            return json.dumps(
                {"cite": [], "quote": "The Quality Manager signs the release form within 24 hours."}
            )
        if "failed batch" in item:  # search: cite the escalation section, wrong quote
            cid = next(line.split('"')[1] for line in prompt.splitlines() if "ESCALATION" in line)
            return json.dumps({"cite": [cid], "quote": "Escalate within a week."})
        if "release owner" in item:  # the JD, beside the question's own cited section
            candidates = prompt.split("CANDIDATES:")[1]
            assert "Release Manager_Final" in candidates
            cid = next(
                line.split('"')[1]
                for line in candidates.splitlines()
                if 'document="Release Manager_Final' in line
            )
            return json.dumps({"cite": [cid], "quote": "Owns the release calendar"})
        return json.dumps({"cite": [], "quote": ""})  # nothing supports "confidence"

    class Llm(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):

            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": True})
            return await choose(prompt)

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    run_id = run.id
    await sop_citation_service.relocate(db_session, run, Llm())

    db_session.expire_all()
    items = {i.text: i for i in await checklist_service.list_items(db_session, checklist)}
    sign = items["Gets the Quality Manager's sign-off"]
    assert json.loads(sign.source_refs) == [{"document_id": widget, "section": "4.2"}]
    assert sign.source_quote == "The Quality Manager signs the release form within 24 hours."
    assert (sign.source_document_id, sign.source_page) == (widget, "p. 3")

    esc = items["Escalates a failed batch the same day"]
    assert json.loads(esc.source_refs) == [{"document_id": widget, "section": "5"}]
    assert esc.source_quote == ""  # not verbatim: dropped, the section kept

    owner = items["Names the release owner"]
    assert json.loads(owner.source_refs) == [{"document_id": jd, "section": "§1"}]
    assert owner.source_quote == "Owns the release calendar"  # quote check ignores the full stop

    vague = items["Speaks with confidence"]
    assert (vague.source_refs, vague.source_document_id, vague.source_quote) == ("[]", None, "")

    run = await db_session.get(CitationRun, run_id)
    rows = json.loads(run.report_json)
    assert (run.status, run.done, run.total) == ("done", 4, 4)
    assert [r["how"] for r in rows] == ["label", "search", "search", "none"]
    assert rows[3]["old"] == {"document_name": "", "quote": "SOP Handbook"}
    assert rows[0]["new"]["sections"] == [
        {"document_name": "Widget Release Procedure.pdf", "section": "4.2", "title": "Approval"}
    ]


async def test_the_relocation_api_runs_in_the_background_and_reports(
    client, db_session, admin_auth
):
    await _corpus(db_session)
    bank, _ = await _bank(
        db_session, [("Gets sign-off", 100, "Widget Release Procedure SOP section 4.2")]
    )
    base = f"/admin/question-banks/{bank.id}/relocate-citations"
    assert (await client.get(base, headers=admin_auth)).json() is None

    started = await client.post(base, headers=admin_auth)
    assert started.status_code == 202 and started.json()["status"] == "running"
    again = await client.post(base, headers=admin_auth)  # one run at a time
    assert again.json()["run_id"] == started.json()["run_id"]
    await asyncio.gather(*sop_citation_service.RUNS)

    latest = (await client.get(base, headers=admin_auth)).json()
    assert (latest["status"], latest["total"]) == ("done", 1)
    assert latest["rows"][0]["how"] == "label"  # the mock cites; the label decides
    assert (
        await client.post("/admin/question-banks/nope/relocate-citations", headers=admin_auth)
    ).status_code == 404


async def test_a_run_counts_as_published_once_a_version_is_published_after_it(
    client, db_session, admin_auth
):
    from datetime import UTC, datetime, timedelta

    await _corpus(db_session)
    bank, _ = await _bank(
        db_session, [("Gets sign-off", 100, "Widget Release Procedure SOP section 4.2")]
    )
    bank_id = bank.id
    base = f"/admin/question-banks/{bank_id}/relocate-citations"
    run_id = (await client.post(base, headers=admin_auth)).json()["run_id"]
    await asyncio.gather(*sop_citation_service.RUNS)
    assert (await client.get(base, headers=admin_auth)).json()["published"] is False

    # SQLite keeps whole seconds (in UTC): put the run's finish clearly before the publish.
    run = await db_session.get(CitationRun, run_id)
    run.updated_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=5)
    await db_session.commit()
    published = await client.post(f"/admin/question-banks/{bank_id}/publish", headers=admin_auth)
    assert published.json()["published"] is True
    assert (await client.get(base, headers=admin_auth)).json()["published"] is True


async def test_a_run_interrupted_by_a_restart_does_not_block_the_next(db_session):
    bank, _ = await _bank(db_session, [("x", 100, "")])
    stale = CitationRun(bank_id=bank.id, status="running")
    db_session.add(stale)
    await db_session.commit()
    stale.updated_at = sop_citation_service._now() - sop_citation_service.STALE_AFTER * 2
    await db_session.commit()
    run = await sop_citation_service.start_relocation(db_session, db_session._test_factory, bank.id)
    assert run.id != stale.id
    await db_session.refresh(stale)
    assert stale.status == "failed" and "interrupted" in stale.error
    await asyncio.gather(*sop_citation_service.RUNS)


async def test_a_failed_run_is_recorded(db_session, monkeypatch):
    bank, _ = await _bank(db_session, [("x", 100, "")])

    async def boom(*_a, **_k):
        raise RuntimeError("index unavailable")

    monkeypatch.setattr(sop_citation_service, "load_index", boom)
    run_id = (
        await sop_citation_service.start_relocation(db_session, db_session._test_factory, bank.id)
    ).id
    await asyncio.gather(*sop_citation_service.RUNS)
    db_session.expire_all()
    run = await db_session.get(CitationRun, run_id)
    assert run.status == "failed" and "index unavailable" in run.error


async def test_the_real_model_picks_the_section_that_states_the_item(db_session):
    """Owner rule: locally the real model, never in CI."""
    llm = _real_judge_adapter()
    if llm is None:
        pytest.skip("no real model configured (CI, or no backend/.env)")
    widget, _ = await _corpus(db_session)
    bank, checklist = await _bank(
        db_session, [("Escalates a failed batch to the site lead", 100, "")]
    )
    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, llm)
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist)
    assert json.loads(item.source_refs)[0] == {"document_id": widget, "section": "5"}
    assert "escalated to the site lead" in item.source_quote


class _Cite1(ScriptedJudgeAdapter):
    name = "scripted"

    async def complete(self, prompt, *, json_mode=False, fast=False):

        if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
            return json.dumps({"about": True})
        return json.dumps({"cite": ["C1"], "quote": ""})


async def test_an_item_saved_during_the_run_is_reported_not_written(db_session, monkeypatch):
    await _corpus(db_session)
    bank, checklist_id = await _bank(db_session, [("Gets sign-off", 100, "")])
    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    run_id = run.id
    real_locate = sop_citation_service._locate

    async def admin_saves_meanwhile(*args, **kwargs):
        located = await real_locate(*args, **kwargs)
        await checklist_service.update_items(
            db_session, checklist_id, [{"kind": "required", "text": "Gets sign-off", "weight": 100}]
        )
        return located

    monkeypatch.setattr(sop_citation_service, "_locate", admin_saves_meanwhile)
    await sop_citation_service.relocate(db_session, run, _Cite1())
    db_session.expire_all()
    (row,) = json.loads((await db_session.get(CitationRun, run_id)).report_json)
    assert row["how"] == "edited" and row["new"]["sections"] == []


async def test_a_second_run_keeps_the_sections_an_item_already_cites(db_session):
    widget, _ = await _corpus(db_session)
    bank, checklist_id = await _bank(db_session, [("Gets sign-off", 100, "")])
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    item.source_refs = json.dumps([{"document_id": widget, "section": "4.2"}])
    await db_session.commit()

    class Quote(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):

            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": True})
            assert "every candidate id" in prompt  # fixed: the model only finds the quote
            return json.dumps({"cite": [], "quote": "The Quality Manager signs the release form"})

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, Quote())
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    assert json.loads(item.source_refs) == [{"document_id": widget, "section": "4.2"}]
    assert item.source_quote == "The Quality Manager signs the release form"


async def test_a_failed_lookup_leaves_the_item_as_it_was(db_session, monkeypatch):
    await _corpus(db_session)
    bank, checklist_id = await _bank(db_session, [("Gets sign-off", 100, "keep me")])

    async def broken(*_a, **_k):
        raise RuntimeError("model down")

    monkeypatch.setattr(sop_citation_service, "_locate", broken)
    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    run_id = run.id
    await sop_citation_service.relocate(db_session, run, _Cite1())
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    assert item.source_quote == "keep me"
    (row,) = json.loads((await db_session.get(CitationRun, run_id)).report_json)
    assert row["how"] == "error"


async def test_the_database_allows_one_running_run_per_bank(db_session):
    from sqlalchemy.exc import IntegrityError

    bank, _ = await _bank(db_session, [("x", 100, "")])
    bank_id = bank.id
    db_session.add(CitationRun(bank_id=bank_id, status="running"))
    await db_session.commit()
    db_session.add(CitationRun(bank_id=bank_id, status="running"))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()
    db_session.add(CitationRun(bank_id=bank_id, status="done"))
    await db_session.commit()  # finished runs are not limited


async def test_a_recent_run_from_another_process_is_not_taken_over(db_session):
    bank, _ = await _bank(db_session, [("x", 100, "")])
    other = CitationRun(bank_id=bank.id, status="running")
    db_session.add(other)
    await db_session.commit()
    other.updated_at = sop_citation_service._now()  # heartbeat just now, not in this process
    await db_session.commit()
    again = await sop_citation_service.start_relocation(
        db_session, db_session._test_factory, bank.id
    )
    assert again.id == other.id


async def test_an_unlabelled_item_is_located_within_its_questions_sources(db_session):
    widget, jd = await _corpus(db_session)
    other = await _doc(
        db_session,
        "Release Train Safety Handbook.pdf",
        [("1", "Release safety", None, "Release safety checks are owned by the safety lead.")],
    )
    bank, _ = await _bank(
        db_session,
        [
            ("Gets sign-off", 50, "Widget Release Procedure SOP section 4.2"),
            ("Factual accuracy about the release", 50, ""),
        ],
    )
    seen: list[str] = []

    class Spy(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):

            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": True})
            seen.append(prompt)
            return json.dumps({"cite": ["C1"], "quote": ""})

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, Spy())
    unlabelled = next(p for p in seen if "RUBRIC ITEM:\nFactual accuracy" in p)
    candidates = unlabelled.split("CANDIDATES:")[1]
    # The question's own cited section comes first; other documents stay out of it.
    assert candidates.index('section="4.2 Approval"') < 200
    assert "Release Train Safety Handbook" not in candidates and other


async def test_a_fresh_run_starts_again_from_the_original_labels(db_session):
    widget, _ = await _corpus(db_session)
    bank, checklist_id = await _bank(
        db_session, [("Gets sign-off", 100, "Widget Release Procedure SOP section 4.2")]
    )
    first = CitationRun(bank_id=bank.id)
    db_session.add(first)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, first, _Cite1())
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    # An admin (or a bad run) re-pointed it elsewhere; the label is gone from the draft.
    item.source_refs = json.dumps([{"document_id": widget, "section": "5"}])
    item.source_quote = "A failed batch is escalated to the site lead the same day."
    await db_session.commit()

    second = CitationRun(bank_id=bank.id)
    db_session.add(second)
    await db_session.commit()
    second_id = second.id
    await sop_citation_service.relocate(db_session, second, _Cite1(), fresh=True)
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    assert json.loads(item.source_refs) == [{"document_id": widget, "section": "4.2"}]
    (row,) = json.loads((await db_session.get(CitationRun, second_id)).report_json)
    assert row["old"]["quote"] == "Widget Release Procedure SOP section 4.2"
    assert row["item_id"] == item.id


async def test_original_labels_come_from_the_first_run_that_saw_each_item(db_session):
    bank, _ = await _bank(db_session, [("x", 100, "")])
    rows1 = [
        {"question": "Q1", "item": "Accuracy", "old": {"quote": "A SOP section 4.2"}},
        {"question": "Q2", "item": "Accuracy", "old": {"quote": "B SOP section 5"}},
        {"question": "Q3", "item": "Dup", "old": {"quote": "label one"}},
        {"question": "Q3", "item": "Dup", "old": {"quote": "label two"}},
    ]
    rows2 = [
        {"item_id": "new", "question": "Q1", "item": "Added later", "old": {"quote": "C SOP"}},
        {"question": "Q1", "item": "Accuracy", "old": {"quote": "a quote written by run 1"}},
    ]
    from datetime import timedelta

    start = sop_citation_service._now()
    for n, rows in enumerate((rows1, rows2)):
        db_session.add(
            CitationRun(
                bank_id=bank.id,
                status="done",
                report_json=json.dumps(rows),
                created_at=start + timedelta(seconds=n),
            )
        )
        await db_session.commit()
    labels = await sop_citation_service._original_labels(db_session, bank.id, before="")
    assert labels[("Q1", "Accuracy")] == "A SOP section 4.2"  # the first run's, not run 2's quote
    assert labels[("Q2", "Accuracy")] == "B SOP section 5"  # same text, other question
    assert ("Q3", "Dup") not in labels  # ambiguous: not guessed
    assert labels["new"] == "C SOP"  # an item first seen by the second run


async def test_a_library_wide_match_needs_a_verbatim_sentence(db_session):
    """A question naming no SOP: the model must back a citation with a copied sentence."""
    await _corpus(db_session)
    bank, checklist_id = await _bank(
        db_session, [("Explains the reasoning", 50, ""), ("Escalates a failed batch", 50, "")]
    )
    prompts: list[str] = []

    class Llm(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):

            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": True})
            prompts.append(prompt)
            item = prompt.split("RUBRIC ITEM:\n")[1].split("\n")[0]
            quote = (
                "A failed batch is escalated to the site lead the same day."
                if "failed" in item
                else ""
            )
            return json.dumps({"cite": ["C1"], "quote": quote})

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, Llm())
    assert all("searching every SOP" in p for p in prompts)
    db_session.expire_all()
    items = {i.text: i for i in await checklist_service.list_items(db_session, checklist_id)}
    assert items["Explains the reasoning"].source_refs == "[]"  # cited, but nothing to quote
    assert json.loads(items["Escalates a failed batch"].source_refs)[0]["section"] == "5"


async def test_an_invented_quote_drops_a_library_wide_match_but_not_a_scoped_one(db_session):
    widget, _ = await _corpus(db_session)
    unscoped, unscoped_list = await _bank(db_session, [("Escalates a failed batch", 100, "")])
    scoped_bank = await question_service.create_bank(db_session, name="Scoped")
    q = await question_service.add_question(
        db_session, bank_id=scoped_bank.id, text="How do you release a batch?", order_index=0
    )
    scoped_list = (
        await checklist_service._persist_draft(
            db_session,
            q.id,
            checklist_service.ChecklistDraft(
                prompt_version="t",
                items=[
                    checklist_service.DraftItem(
                        kind="required",
                        text="Gets sign-off",
                        weight=50,
                        source_quote="Widget Release Procedure SOP section 4.2",
                    ),
                    checklist_service.DraftItem(kind="required", text="Escalates", weight=50),
                ],
            ),
        )
    ).id

    class Invents(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):

            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": True})
            return json.dumps({"cite": ["C1"], "quote": "A sentence that is in no section at all."})

    for bank_id in (unscoped.id, scoped_bank.id):
        run = CitationRun(bank_id=bank_id)
        db_session.add(run)
        await db_session.commit()
        await sop_citation_service.relocate(db_session, run, Invents())
    db_session.expire_all()
    (lonely,) = await checklist_service.list_items(db_session, unscoped_list)
    assert lonely.source_refs == "[]"  # library-wide, invented quote: nothing kept
    scoped = {i.text: i for i in await checklist_service.list_items(db_session, scoped_list)}
    # Scoped by its question's label: the section is kept, only the quote is dropped.
    assert json.loads(scoped["Escalates"].source_refs) != []
    assert scoped["Escalates"].source_quote == ""
    assert json.loads(scoped["Gets sign-off"].source_refs) == [
        {"document_id": widget, "section": "4.2"}
    ]


async def test_a_question_the_library_does_not_cover_cites_nothing(db_session):
    """Asked once per question that names no SOP: off-topic means no item is cited."""
    await _corpus(db_session)
    bank, checklist_id = await _bank(db_session, [("Skips the safety check", 100, "")])
    asked: list[str] = []

    class OffTopic(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):
            asked.append(prompt)
            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                return json.dumps({"about": False})
            return json.dumps(
                {"cite": ["C1"], "quote": "Every widget is inspected before it is packed."}
            )

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    run_id = run.id
    await sop_citation_service.relocate(db_session, run, OffTopic())
    assert len(asked) == 1  # the topic question only: no per-item call
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    assert item.source_refs == "[]"
    (row,) = json.loads((await db_session.get(CitationRun, run_id)).report_json)
    assert row["how"] == "off_topic"


async def test_a_bank_about_another_subject_cites_none_of_its_unlabelled_questions(
    db_session,
):
    await _corpus(db_session)
    bank = await question_service.create_bank(db_session, name="Deploys")
    lists = []
    for n, text in enumerate(
        ["Walk me through your pre-deploy checks.", "A deploy fails.", "Rollback?"]
    ):
        q = await question_service.add_question(
            db_session, bank_id=bank.id, text=text, order_index=n
        )
        lists.append(
            (
                await checklist_service._persist_draft(
                    db_session,
                    q.id,
                    checklist_service.ChecklistDraft(
                        prompt_version="t",
                        items=[
                            checklist_service.DraftItem(kind="required", text="Checks", weight=100)
                        ],
                    ),
                )
            ).id
        )

    asked: list[str] = []

    class OneOfThree(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):
            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                asked.append(prompt)
                return json.dumps({"about": False})
            return json.dumps(
                {"cite": ["C1"], "quote": "Every widget is inspected before it is packed."}
            )

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, OneOfThree())
    db_session.expire_all()
    for checklist_id in lists:
        (item,) = await checklist_service.list_items(db_session, checklist_id)
        assert item.source_refs == "[]"
    # One decision for the whole bank: every question listed, beside the library.
    (prompt,) = asked
    assert all(q in prompt for q in ("pre-deploy checks", "A deploy fails.", "Rollback?"))
    assert "- Widget Release Procedure.pdf" in prompt.split("SOP LIBRARY")[1]


async def test_an_unanswered_topic_check_is_unknown_and_never_wipes(db_session):
    """A failed or unparseable topic answer is unknown: left out of the bank vote, and that
    question is located item by item instead of being declared off-topic."""
    await _corpus(db_session)
    bank, checklist_id = await _bank(db_session, [("Escalates a failed batch", 100, "")])

    class Broken(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):
            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                raise RuntimeError("model unavailable")
            cid = next(line.split('"')[1] for line in prompt.splitlines() if "ESCALATION" in line)
            quote = "A failed batch is escalated to the site lead the same day."
            return json.dumps({"cite": [cid], "quote": quote})

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, Broken())
    db_session.expire_all()
    (item,) = await checklist_service.list_items(db_session, checklist_id)
    assert json.loads(item.source_refs)[0]["section"] == "5"


async def test_the_library_lists_each_converted_sop_with_its_purpose(db_session):
    widget, _ = await _corpus(db_session)
    document = await db_session.get(SopDocument, widget)
    document.summary = "**Purpose:** Release widgets\n  safely.\n\n**Scope:** All sites."
    db_session.add(
        SopDocument(name="Not converted.pdf", status="chunked", markdown_source="failed")
    )
    await db_session.commit()
    library = await sop_citation_service.library(db_session)
    assert "- Widget Release Procedure.pdf: Release widgets" in library
    assert "- Release Manager_Final (1).docx" in library  # no summary: the name alone
    assert "Not converted" not in library


async def test_only_unlabelled_questions_are_put_to_the_topic_check(db_session):
    await _corpus(db_session)
    bank = await question_service.create_bank(db_session, name="Mixed")
    for n, (text, label) in enumerate(
        [
            ("How is a release approved?", "Widget Release Procedure SOP section 4.2"),
            ("Tell us about yourself.", ""),
        ]
    ):
        q = await question_service.add_question(
            db_session, bank_id=bank.id, text=text, order_index=n
        )
        await checklist_service._persist_draft(
            db_session,
            q.id,
            checklist_service.ChecklistDraft(
                prompt_version="t",
                items=[
                    checklist_service.DraftItem(
                        kind="required", text="x", weight=100, source_quote=label
                    )
                ],
            ),
        )
    asked: list[str] = []

    class Llm(ScriptedJudgeAdapter):
        name = "scripted"

        async def complete(self, prompt, *, json_mode=False, fast=False):
            if sop_citation_service.TOPIC_PROMPT_MARKER in prompt:
                asked.append(prompt)
                return json.dumps({"about": False})
            return json.dumps({"cite": [], "quote": ""})

    run = CitationRun(bank_id=bank.id)
    db_session.add(run)
    await db_session.commit()
    await sop_citation_service.relocate(db_session, run, Llm())
    (prompt,) = asked
    bank_part = prompt.split("QUESTION BANK:")[1]
    assert "Tell us about yourself." in bank_part
    assert "How is a release approved?" not in bank_part
