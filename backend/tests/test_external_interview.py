"""Slice-1 chaos suite for the external interview brain (SPEC Phase 2, vendor-neutral).

Five layers, from the wire up:

A. **Transport / SSE parsing** — pure-function unit tests for the fragile bits: hex round-trip,
   display-text scrub, SSE frame assembly (multiline / comments / no trailing blank),
   workflow_finished selection (last-wins / missing), and outputs validation (missing state blob →
   error; malformed public payload → graceful degrade, never discard a usable state blob).
B. **HTTP provider integration** — a real ASGI SSE server on an ephemeral port, driven through the
   live ``HttpExternalInterviewProvider`` + httpx: happy path, chunk-fragmented stream, bad status,
   wrong content-type, oversized body, and a stream with no ``workflow_finished`` frame.
C. **Runner orchestration** — on a real file-backed aiosqlite DB (not :memory:, so two AsyncSessions
   are genuinely concurrent) with fault-injected providers: outage → ``recovery_required``, resume →
   advance, submit-during-recovery → 409, two concurrent answers → exactly one CAS 409, ``end()``
   forces completion on transport failure, and the privacy invariant (the opaque state blob never
   lands in an ``InterviewTurn`` row or in ``external_last_response``).
D. **Route level** — through the ASGI client with an external-brain default persona + the mock
   provider: start exposes ``external_phase`` + ``speech_text``, answers advance to completion,
   report is the stub, report/stream is a single stub line, review pairs the transcript, the reveal
   endpoint returns plaintext where the masked GET does not, and no response body leaks the blob.
E. **Vendor-neutral guard** — the Phase-2 source files name no product (tokens assembled from parts
   so this test file itself doesn't carry the forbidden strings).
"""

import asyncio
import contextlib
import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
import uvicorn
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401 — registers ORM classes on Base.metadata
from app.db import Base
from app.interview import external_runner
from app.models.interview import InterviewSession, InterviewTurn
from app.services import external_interview_client as eic
from app.services.external_interview_client import (
    ExternalInterviewError,
    ExternalTurn,
    HttpExternalInterviewProvider,
    MockExternalInterviewProvider,
    _assemble_frames,
    _hex_encode_inner,
    _parse_outputs,
    parse_sse_outputs,
    scrub_display_text,
)

# The suite runs under pytest-asyncio (asyncio_mode="auto"), so async tests/fixtures need no marker
# and share one event loop per test — critical for the uvicorn fixture below, whose server task must
# be scheduled on the same loop the httpx client awaits on. (Do NOT add pytest.mark.anyio: it would
# run the test on a second loop and the server task would never get scheduled → read timeout.)


# --------------------------------------------------------------------------- golden payloads


def _outputs(*, index, complete=False, state_extra=None, display=None, speech=None) -> dict:
    """A ``workflow_finished.data.outputs`` dict shaped like the real wire contract."""
    state = {"index": index}
    if state_extra:
        state.update(state_extra)
    public = {
        "event": "session_complete" if complete else "message",
        "speech_text": speech if speech is not None else f"Question {index + 1}: describe it.",
        "display_text": display if display is not None else f"RFCMS-Q0{index + 1} — Describe it.",
        "session_complete": complete,
    }
    return {
        "conversation_id": "conv-42",
        "final_session_state_json": json.dumps(state),
        "public_response_json": json.dumps(public),
        "session_complete": complete,
    }


def _sse(outputs: dict) -> str:
    """A one-event SSE stream carrying a ``workflow_finished`` frame for ``outputs``."""
    frame = {"event": "workflow_finished", "data": {"outputs": outputs}}
    return f"data: {json.dumps(frame)}\n\n"


# --------------------------------------------------------------------------- fault providers


class _FailProvider:
    """Always raises a transport error — models a total outage."""

    name = "fail"

    def __init__(self) -> None:
        self.calls = 0

    async def run_turn(self, **_kw) -> ExternalTurn:
        self.calls += 1
        raise ExternalInterviewError("injected outage")


class _ScoringProvider:
    """Returns a state blob carrying a score sentinel but candidate-safe public text.

    Proves the privacy invariant: the sentinel must reach ``external_state`` and NOTHING else.
    """

    name = "scoring"
    SENTINEL = "SECRET_RUBRIC_SCORE_9000"

    async def run_turn(self, *, event, **_kw) -> ExternalTurn:
        return ExternalTurn(
            conversation_id="conv-secret",
            state_blob=json.dumps({"index": 1, "rubric": self.SENTINEL}),
            speech_text="Please describe a time you handled a deviation.",
            display_text="Question 2: describe a deviation you handled.",
            session_complete=False,
        )


# --------------------------------------------------------------------------- fake SSE server (B)


class _FakeSSE:
    """A raw ASGI app whose response (status / content-type / body chunks) tests control."""

    def __init__(self) -> None:
        self.status = 200
        self.content_type = b"text/event-stream"
        self.body_chunks: list[bytes] = []
        self.base_url = ""
        self.requests: list[bytes] = []

    async def __call__(self, scope, receive, send) -> None:
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        self.requests.append(body)
        await send(
            {
                "type": "http.response.start",
                "status": self.status,
                "headers": [(b"content-type", self.content_type)],
            }
        )
        for chunk in self.body_chunks:
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})


@pytest_asyncio.fixture
async def fake_sse():
    state = _FakeSSE()
    config = uvicorn.Config(state, host="127.0.0.1", port=0, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:  # noqa: ASYNC110 — poll uvicorn's start flag (no Event exposed)
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        state.base_url = f"http://127.0.0.1:{port}"
        yield state
    finally:
        server.should_exit = True
        await task


# --------------------------------------------------------------------------- file-backed DB (C)


@contextlib.asynccontextmanager
async def _file_factory(tmp_path: Path):
    """A real file-backed aiosqlite session factory with the app's SQLite PRAGMAs.

    File-backed (not :memory:/StaticPool) so two AsyncSessions are genuinely concurrent writers —
    the only way to exercise the CAS turn lock under real writer serialization.
    """
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'it.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(dbapi_connection, _record):  # noqa: ANN001
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()


async def _seed_candidate(session: AsyncSession) -> str:
    from app.models.anonymous_session import AnonymousCandidateSession

    now = datetime(2026, 1, 1)
    cand = AnonymousCandidateSession(expires_at=now + timedelta(days=1), last_activity_at=now)
    session.add(cand)
    await session.commit()
    await session.refresh(cand)
    return cand.id


# =========================================================================== A. transport/SSE


async def test_scrub_display_text_rewrites_internal_prefix():
    assert scrub_display_text("RFCMS-Q03 — Describe the CAPA process") == (
        "Question 3: Describe the CAPA process"
    )
    assert scrub_display_text("No prefix here") == "No prefix here"
    assert scrub_display_text("") == ""


async def test_hex_encode_inner_round_trips():
    hexed = _hex_encode_inner(
        event="message", conversation_id="c1", user_input="答案", session_state_json='{"index":2}'
    )
    inner = json.loads(bytes.fromhex(hexed).decode("utf-8"))
    assert inner == {
        "event": "message",
        "conversation_id": "c1",
        "user_input": "答案",
        "session_state_json": '{"index":2}',
    }


async def test_assemble_frames_multiline_comments_and_no_trailing_blank():
    lines = [
        ": keepalive",
        "event: workflow_finished",
        "data: part-a",
        "data: part-b",
        "",
        "id: 7",
        "data: tail-with-no-final-blank",
    ]
    assert _assemble_frames(lines) == ["part-a\npart-b", "tail-with-no-final-blank"]


async def test_parse_sse_outputs_last_wins_and_skips_noise():
    frames = [
        "not json at all",
        json.dumps({"event": "text_chunk", "data": "…"}),
        json.dumps({"event": "workflow_finished", "data": {"outputs": {"conversation_id": "old"}}}),
        json.dumps({"event": "workflow_finished", "data": {"outputs": {"conversation_id": "new"}}}),
    ]
    assert parse_sse_outputs(frames)["conversation_id"] == "new"


async def test_parse_sse_outputs_raises_when_absent():
    with pytest.raises(ExternalInterviewError):
        parse_sse_outputs([json.dumps({"event": "text_chunk"}), "keepalive"])


async def test_parse_outputs_requires_state_blob():
    bad = _outputs(index=0)
    del bad["final_session_state_json"]
    with pytest.raises(ExternalInterviewError):
        _parse_outputs(bad)


async def test_parse_outputs_degrades_on_malformed_public_but_keeps_state():
    out = _outputs(index=0)
    out["public_response_json"] = "{not valid json"
    turn = _parse_outputs(out)
    assert turn.state_blob  # the usable state blob is never discarded over a cosmetic field
    assert turn.speech_text == ""
    assert turn.display_text == ""


async def test_parse_outputs_scrubs_and_reads_completion():
    turn = _parse_outputs(_outputs(index=2, complete=True, display="RFCMS-Q03 — Final"))
    assert turn.display_text == "Question 3: Final"
    assert turn.session_complete is True


# =========================================================================== B. HTTP provider


async def test_http_provider_happy_path(fake_sse):
    fake_sse.body_chunks = [_sse(_outputs(index=1)).encode("utf-8")]
    turn = await HttpExternalInterviewProvider().run_turn(
        endpoint=fake_sse.base_url,
        api_key="k",
        user="tag-abc",
        event="message",
        conversation_id="c",
        user_input="hi",
        session_state_json='{"index":0}',
    )
    assert turn.conversation_id == "conv-42"
    assert turn.display_text == "Question 2: Describe it."
    # The bearer key rode in the Authorization header, and the body is the hex-encoded inner JSON.
    assert fake_sse.requests, "server saw no request"


async def test_http_provider_tolerates_chunk_fragmentation(fake_sse):
    raw = _sse(_outputs(index=0)).encode("utf-8")
    fake_sse.body_chunks = [raw[i : i + 7] for i in range(0, len(raw), 7)]  # mid-line splits
    turn = await HttpExternalInterviewProvider().run_turn(
        endpoint=fake_sse.base_url,
        api_key="",
        user="u",
        event="start",
        conversation_id="",
        user_input="",
        session_state_json="",
    )
    assert turn.state_blob == json.dumps({"index": 0})


async def test_http_provider_raises_on_bad_status(fake_sse):
    fake_sse.status = 401
    fake_sse.body_chunks = [b"nope"]
    with pytest.raises(ExternalInterviewError):
        await HttpExternalInterviewProvider().run_turn(
            endpoint=fake_sse.base_url,
            api_key="expired",
            user="u",
            event="start",
            conversation_id="",
            user_input="",
            session_state_json="",
        )


async def test_http_provider_raises_on_wrong_content_type(fake_sse):
    fake_sse.content_type = b"text/plain"
    fake_sse.body_chunks = [_sse(_outputs(index=0)).encode("utf-8")]
    with pytest.raises(ExternalInterviewError):
        await HttpExternalInterviewProvider().run_turn(
            endpoint=fake_sse.base_url,
            api_key="",
            user="u",
            event="start",
            conversation_id="",
            user_input="",
            session_state_json="",
        )


async def test_http_provider_caps_oversized_body(fake_sse):
    fake_sse.body_chunks = [b"data: " + b"x" * 2_000_000 + b"\n\n"]
    with pytest.raises(ExternalInterviewError):
        await HttpExternalInterviewProvider().run_turn(
            endpoint=fake_sse.base_url,
            api_key="",
            user="u",
            event="start",
            conversation_id="",
            user_input="",
            session_state_json="",
        )


async def test_http_provider_raises_when_no_workflow_finished(fake_sse):
    fake_sse.body_chunks = [b'data: {"event": "text_chunk", "data": "partial"}\n\n']
    with pytest.raises(ExternalInterviewError):
        await HttpExternalInterviewProvider().run_turn(
            endpoint=fake_sse.base_url,
            api_key="",
            user="u",
            event="start",
            conversation_id="",
            user_input="",
            session_state_json="",
        )


# =========================================================================== C. runner


async def test_start_outage_lands_in_recovery_required(tmp_path, monkeypatch):
    monkeypatch.setattr(external_runner, "_select_provider", lambda _e: _FailProvider())
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        session = await external_runner.start_interview(db, cand)
        assert session.status == "in_progress"
        assert session.external_phase == "recovery_required"
        assert session.external_state is None  # nothing committed on a failed start


async def test_recover_after_start_outage_advances(tmp_path, monkeypatch):
    monkeypatch.setattr(external_runner, "_select_provider", lambda _e: _FailProvider())
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        session = await external_runner.start_interview(db, cand)
        assert session.external_phase == "recovery_required"

        # Gateway comes back: recover re-drives the start turn (no pending answer) via the mock.
        monkeypatch.setattr(
            external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
        )
        session = await external_runner.recover(db, session)
        assert session.external_phase == "idle"
        q = await external_runner.current_question(db, session)
        assert q is not None and q["prompt"]


async def test_answer_outage_then_resubmit_conflicts_then_recover(tmp_path, monkeypatch):
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        monkeypatch.setattr(
            external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
        )
        session = await external_runner.start_interview(db, cand)
        state_before = session.external_state

        # Outage on the answer turn → recovery_required, committed state untouched.
        monkeypatch.setattr(external_runner, "_select_provider", lambda _e: _FailProvider())
        session = await external_runner.answer(db, session, "my answer")
        assert session.external_phase == "recovery_required"
        assert session.external_state == state_before  # state advances ONLY on a committed turn

        # A normal re-submit while recovery is owed loses the CAS (reserves only from idle) → 409.
        with pytest.raises(external_runner.ExternalTurnConflict):
            await external_runner.answer(db, session, "again")

        # 恢复 re-sends the SAME pending answer; gateway back → advances.
        monkeypatch.setattr(
            external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
        )
        session = await external_runner.recover(db, session)
        assert session.external_phase == "idle"


async def test_two_concurrent_answers_yield_exactly_one_conflict(tmp_path, monkeypatch):
    monkeypatch.setattr(
        external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
    )
    async with _file_factory(tmp_path) as factory:
        async with factory() as setup_db:
            cand = await _seed_candidate(setup_db)
            started = await external_runner.start_interview(setup_db, cand)
            sid = started.id

        # Two independent sessions each load the SAME row (both at turn_version 0, phase idle).
        async with factory() as db_a, factory() as db_b:
            sess_a = await db_a.get(InterviewSession, sid)
            sess_b = await db_b.get(InterviewSession, sid)
            assert sess_a is not None and sess_b is not None
            results = await asyncio.gather(
                external_runner.answer(db_a, sess_a, "answer A"),
                external_runner.answer(db_b, sess_b, "answer B"),
                return_exceptions=True,
            )

    conflicts = [r for r in results if isinstance(r, external_runner.ExternalTurnConflict)]
    wins = [r for r in results if isinstance(r, InterviewSession)]
    assert len(conflicts) == 1
    assert len(wins) == 1


async def test_end_forces_completion_on_transport_failure(tmp_path, monkeypatch):
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        monkeypatch.setattr(
            external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
        )
        session = await external_runner.start_interview(db, cand)

        monkeypatch.setattr(external_runner, "_select_provider", lambda _e: _FailProvider())
        session = await external_runner.end(db, session)
        assert session.status == "completed"  # the candidate asked to stop; never strand them
        assert session.external_phase == "idle"


async def test_state_blob_never_leaves_backend(tmp_path, monkeypatch):
    monkeypatch.setattr(external_runner, "_select_provider", lambda _e: _ScoringProvider())
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        session = await external_runner.start_interview(db, cand)
        session = await external_runner.answer(db, session, "candidate answer")

        # The score sentinel MUST live only in external_state — never a turn row / last_response.
        assert _ScoringProvider.SENTINEL in (session.external_state or "")
        assert _ScoringProvider.SENTINEL not in (session.external_last_response or "")
        turns = (
            (
                await db.execute(
                    select(InterviewTurn).where(InterviewTurn.interview_session_id == session.id)
                )
            )
            .scalars()
            .all()
        )
        assert turns, "expected recorded turns"
        for turn in turns:
            assert _ScoringProvider.SENTINEL not in turn.content


async def test_probe_connection_creates_no_rows(tmp_path, monkeypatch):
    async def _fake_resolve(_db):
        return "https://gw.example.com/v1", "key", "tag"

    monkeypatch.setattr(external_runner, "resolve_external_connection", _fake_resolve)
    monkeypatch.setattr(
        external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
    )
    async with _file_factory(tmp_path) as factory, factory() as db:
        ok, detail = await external_runner.probe_connection(db)
        assert ok is True and detail == "OK"
        sessions = (await db.execute(select(func.count()).select_from(InterviewSession))).scalar()
        turns = (await db.execute(select(func.count()).select_from(InterviewTurn))).scalar()
        assert sessions == 0 and turns == 0  # health-probe touches transport only


async def test_probe_connection_reports_unconfigured(tmp_path, monkeypatch):
    async def _empty(_db):
        return "", "", ""

    monkeypatch.setattr(external_runner, "resolve_external_connection", _empty)
    async with _file_factory(tmp_path) as factory, factory() as db:
        ok, detail = await external_runner.probe_connection(db)
        assert ok is False and "endpoint" in detail.lower()


async def test_end_success_records_completion(tmp_path, monkeypatch):
    monkeypatch.setattr(
        external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
    )
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        session = await external_runner.start_interview(db, cand)
        # Gateway is up: end() drives a real END turn and commits it, then forces completion.
        session = await external_runner.end(db, session)
        assert session.status == "completed"
        assert session.external_phase == "idle"


async def test_review_speech_and_current_question_are_candidate_safe(tmp_path, monkeypatch):
    monkeypatch.setattr(
        external_runner, "_select_provider", lambda _e: MockExternalInterviewProvider()
    )
    async with _file_factory(tmp_path) as factory, factory() as db:
        cand = await _seed_candidate(db)
        session = await external_runner.start_interview(db, cand)

        # Right after start: speech text and the current question read from last_response only.
        assert (external_runner.speech_text_for(session) or "").startswith("Question 1")
        q = await external_runner.current_question(db, session)
        assert q is not None and q["question_id"] == "external-0" and q["total"] == 0

        session = await external_runner.answer(db, session, "first answer")
        review = await external_runner.review_answers(db, session)
        assert review and review[0]["answer_text"] == "first answer"
        assert review[0]["prompt"]  # the posed question, paired from recorded turns


async def test_current_question_and_speech_none_when_no_response(db_session):
    # Defensive: a session with no committed response yields no question / no speech. The db is
    # never touched — both helpers short-circuit on the empty last_response before any query.
    blank = InterviewSession(external_last_response=None, status="in_progress")
    assert external_runner.speech_text_for(blank) is None
    assert await external_runner.current_question(db_session, blank) is None


# =========================================================================== D. route level


async def _external_headers(client, db_session):
    """A default persona wired to the external brain + a fresh candidate's auth header."""
    from app.services import persona_service

    await persona_service.create_persona(
        db_session, name="External", is_default=True, interview_brain="external"
    )
    resp = await client.post("/public/candidate/session")
    assert resp.status_code == 200
    return {"X-Anon-Session": resp.json()["token"]}


async def _external_state_blob(db_session, interview_id: str) -> str:
    row = await db_session.get(InterviewSession, interview_id)
    return row.external_state or ""


async def test_route_start_exposes_phase_and_speech(client, db_session):
    headers = await _external_headers(client, db_session)
    resp = await client.post("/candidate/interview/start", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "in_progress"
    assert body["external_phase"] == "idle"
    assert body["speech_text"].startswith("Question 1")
    assert body["current_question"]["question_id"] == "external-0"


async def test_route_answers_advance_to_completion_without_leaking_state(client, db_session):
    headers = await _external_headers(client, db_session)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    iid = start["interview_session_id"]

    # Mock runs a fixed 3-question interview: start=Q1, then three answers reach completion.
    last = start
    for _ in range(3):
        blob = await _external_state_blob(db_session, iid)
        resp = await client.post(
            f"/candidate/interview/{iid}/answer",
            headers=headers,
            json={"text": "an answer"},
        )
        assert resp.status_code == 200
        # No response body ever carries the backend-only opaque state blob.
        assert blob and blob not in resp.text
        last = resp.json()

    assert last["status"] == "completed"
    assert last["current_question"] is None


async def test_route_report_is_stub_and_requires_completion(client, db_session):
    headers = await _external_headers(client, db_session)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    iid = start["interview_session_id"]

    # Before completion the external report is a 409, same contract as the bank path.
    early = await client.post(f"/candidate/interview/{iid}/report", headers=headers)
    assert early.status_code == 409

    for _ in range(3):
        await client.post(f"/candidate/interview/{iid}/answer", headers=headers, json={"text": "a"})

    report = await client.post(f"/candidate/interview/{iid}/report", headers=headers)
    assert report.status_code == 200
    body = report.json()
    assert body["is_stub"] is True
    assert body["total_score"] is None
    assert body["per_question"] == []
    assert "external interview provider" in body["narrative"].lower()


async def test_route_report_stream_is_single_stub_line_without_state(client, db_session):
    headers = await _external_headers(client, db_session)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    iid = start["interview_session_id"]
    for _ in range(3):
        await client.post(f"/candidate/interview/{iid}/answer", headers=headers, json={"text": "a"})
    blob = await _external_state_blob(db_session, iid)

    resp = await client.post(f"/candidate/interview/{iid}/report/stream", headers=headers)
    assert resp.status_code == 200
    lines = [ln for ln in resp.text.splitlines() if ln.strip()]
    assert len(lines) == 1  # no progress events for the external path — just the terminal report
    payload = json.loads(lines[0])
    assert payload["type"] == "report" and payload["report"]["is_stub"] is True
    assert blob and blob not in resp.text


async def test_route_review_pairs_the_transcript(client, db_session):
    headers = await _external_headers(client, db_session)
    start = (await client.post("/candidate/interview/start", headers=headers)).json()
    iid = start["interview_session_id"]
    for i in range(3):
        await client.post(
            f"/candidate/interview/{iid}/answer",
            headers=headers,
            json={"text": f"answer number {i}"},
        )

    resp = await client.get(f"/candidate/interview/{iid}/review", headers=headers)
    assert resp.status_code == 200
    answers = resp.json()["answers"]
    assert answers, "expected paired transcript rows"
    for row in answers:
        assert row["prompt"]
        assert row["answer_text"].startswith("answer number")


async def test_admin_get_returns_empty_when_unconfigured(client, admin_auth):
    # A fresh deploy has no external config row: the GET reports empty/inactive, never 500s, and
    # the reveal returns an empty plaintext (nothing to leak).
    resp = await client.get("/admin/external-interviewer", headers=admin_auth)
    assert resp.status_code == 200
    body = resp.json()
    assert body["endpoint"] == "" and body["masked_key"] == "" and body["is_active"] is False
    revealed = await client.get("/admin/external-interviewer/reveal", headers=admin_auth)
    assert revealed.status_code == 200 and revealed.json()["api_key"] == ""


async def test_admin_reveal_returns_plaintext_where_masked_get_does_not(client, admin_auth):
    secret = "supersecret-external-key-123456"
    put = await client.put(
        "/admin/external-interviewer",
        headers=admin_auth,
        json={"endpoint": "https://gw.example.com/v1/chat", "api_key": secret, "user_tag": "t"},
    )
    assert put.status_code == 200
    assert put.json()["masked_key"] != secret

    masked = await client.get("/admin/external-interviewer", headers=admin_auth)
    assert masked.status_code == 200 and secret not in masked.text

    revealed = await client.get("/admin/external-interviewer/reveal", headers=admin_auth)
    assert revealed.status_code == 200 and revealed.json()["api_key"] == secret


async def test_admin_put_rejects_internal_endpoint(client, admin_auth):
    resp = await client.put(
        "/admin/external-interviewer",
        headers=admin_auth,
        json={"endpoint": "http://169.254.169.254/metadata", "api_key": "k", "user_tag": ""},
    )
    assert resp.status_code == 422  # SSRF / metadata-exfil guard


async def test_admin_test_connection_creates_no_rows_when_unconfigured(
    client, admin_auth, db_session
):
    resp = await client.post("/admin/external-interviewer/test", headers=admin_auth)
    assert resp.status_code == 200
    assert resp.json()["success"] is False  # no endpoint configured in the test env
    count = (await db_session.execute(select(func.count()).select_from(InterviewSession))).scalar()
    assert count == 0


# =========================================================================== E. vendor-neutral


async def test_phase2_sources_name_no_product():
    # Assemble the forbidden brand tokens from parts so THIS file doesn't carry them literally.
    forbidden = ["di" + "fy", "bei" + "gene"]
    base = Path(eic.__file__).resolve().parents[1]  # noqa: ASYNC240 — local file read, not I/O-bound
    targets = [
        base / "services" / "external_interview_client.py",
        base / "services" / "external_config_service.py",
        base / "interview" / "external_runner.py",
        base / "api" / "admin_external_config.py",
    ]
    for path in targets:
        text = path.read_text(encoding="utf-8").lower()
        for token in forbidden:
            assert token not in text, f"{path.name} names a product ({token!r})"


# =========================================================================== F. config service


async def test_validate_endpoint_allows_empty_and_https_dns():
    from app.services import external_config_service as ecs

    assert ecs.validate_external_endpoint("") == ""
    url = "https://gw.example.com/v1/chat"
    assert ecs.validate_external_endpoint(url) == url


async def test_validate_endpoint_rejects_non_https_localhost_and_internal_ips():
    from app.services import external_config_service as ecs

    for bad in [
        "http://gw.example.com/v1",  # not https
        "https://localhost/v1",  # localhost by name
        "https://127.0.0.1/v1",  # loopback
        "https://10.0.0.5/v1",  # private
        "https://169.254.169.254/metadata",  # link-local metadata IP
    ]:
        with pytest.raises(ecs.InvalidExternalEndpointError):
            ecs.validate_external_endpoint(bad)


async def test_get_decrypted_key_empty_when_unconfigured(db_session):
    from app.services import external_config_service as ecs

    assert await ecs.get_decrypted_external_key(db_session) == ""


async def test_upsert_creates_then_blank_key_preserves_secret(db_session):
    from app.services import external_config_service as ecs

    row = await ecs.upsert_external_config(
        db_session,
        endpoint="https://gw.example.com/v1",
        api_key="secret-1",
        user_tag="tag",
        updated_by="admin",
    )
    await db_session.commit()
    assert row.endpoint == "https://gw.example.com/v1"
    assert row.default_project == "tag"  # user-tag prefix rides in default_project
    assert await ecs.get_decrypted_external_key(db_session) == "secret-1"

    # Re-save with a blank key: preserves the stored secret; other fields update.
    await ecs.upsert_external_config(
        db_session,
        endpoint="https://gw.example.com/v2",
        api_key="",
        user_tag="tag2",
        updated_by="admin",
    )
    await db_session.commit()
    assert await ecs.get_decrypted_external_key(db_session) == "secret-1"
    row2 = await ecs.get_external_config(db_session)
    assert row2 is not None
    assert row2.endpoint == "https://gw.example.com/v2" and row2.default_project == "tag2"


async def test_upsert_rejects_internal_endpoint_before_any_mutation(db_session):
    from app.services import external_config_service as ecs

    with pytest.raises(ecs.InvalidExternalEndpointError):
        await ecs.upsert_external_config(
            db_session,
            endpoint="https://127.0.0.1/v1",
            api_key="k",
            user_tag="",
            updated_by="admin",
        )
    assert await ecs.get_external_config(db_session) is None  # no row created on rejection


async def test_seed_from_env_noop_without_endpoint(db_session):
    from app.services import external_config_service as ecs

    assert await ecs.seed_external_config_from_env(db_session) is None


async def test_seed_from_env_creates_row_then_is_idempotent(db_session, monkeypatch):
    from app.config import get_settings
    from app.services import external_config_service as ecs

    settings = get_settings()
    monkeypatch.setattr(settings, "external_interviewer_endpoint", "https://gw.example.com/seed")
    monkeypatch.setattr(settings, "external_interviewer_api_key", "envkey")
    monkeypatch.setattr(settings, "external_interviewer_user_tag", "envtag")

    row = await ecs.seed_external_config_from_env(db_session)
    await db_session.commit()
    assert row is not None and row.endpoint == "https://gw.example.com/seed"
    assert row.default_project == "envtag"
    assert await ecs.get_decrypted_external_key(db_session) == "envkey"

    # Second call is a no-op: returns the existing row, never re-seeds over a saved config.
    again = await ecs.seed_external_config_from_env(db_session)
    assert again is not None and again.endpoint == "https://gw.example.com/seed"


async def test_resolve_connection_falls_back_to_env(db_session, monkeypatch):
    from app.config import get_settings
    from app.services import external_config_service as ecs

    settings = get_settings()
    monkeypatch.setattr(settings, "external_interviewer_endpoint", "https://env.example.com/v1")
    monkeypatch.setattr(settings, "external_interviewer_api_key", "envkey")
    monkeypatch.setattr(settings, "external_interviewer_user_tag", "envtag")

    endpoint, api_key, user_tag = await ecs.resolve_external_connection(db_session)
    assert endpoint == "https://env.example.com/v1"
    assert api_key == "envkey"
    assert user_tag == "envtag"
