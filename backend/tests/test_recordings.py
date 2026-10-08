"""Candidate voice recordings: the microphone only, one WAV per question, admin-only playback."""

import io
import wave

import pytest

from app.models.interview import InterviewRecording, InterviewSession
from app.services import recording_service, storage
from app.services.voice_live_proxy import handle_recording_marker

pytestmark = pytest.mark.asyncio

RATE = 16000


def _pcm(seconds: float) -> bytes:
    return b"\x01\x00" * int(RATE * seconds)


@pytest.fixture(autouse=True)
def _local_store(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "_STORES", {})
    monkeypatch.setattr(storage, "_default_root", lambda: str(tmp_path))


async def _interview(db) -> str:
    from app.services.anonymous_session_service import create_anonymous_session

    cand, _ = await create_anonymous_session(db, ip_address="1.2.3.4")
    session = InterviewSession(candidate_session_id=cand.id, status="in_progress")
    db.add(session)
    await db.commit()
    return session.id


async def _rows(db, interview_id):
    return list(await recording_service.list_recordings(db, interview_id))


async def test_each_question_becomes_one_wav_and_nothing_before_the_first(db_session):
    interview_id = await _interview(db_session)
    rec = recording_service.QuestionRecorder(db_session._test_factory, interview_id, RATE)
    rec.append(_pcm(2))  # before the first question: not kept
    await rec.start_question(0)
    rec.append(_pcm(1.5))
    await rec.start_question(1)
    rec.append(_pcm(0.2))  # a click, too short to keep
    await rec.start_question(2)
    rec.append(_pcm(3))
    await rec.close()

    rows = await _rows(db_session, interview_id)
    assert [(r.question_index, r.duration_ms) for r in rows] == [(0, 1500), (2, 3000)]
    audio = recording_service.load_audio(rows[1])
    with wave.open(io.BytesIO(audio)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, RATE)
        assert wav.getnframes() == RATE * 3


async def test_a_storage_failure_never_raises(db_session, monkeypatch):
    interview_id = await _interview(db_session)

    class Broken:
        name = "azure"

        def save(self, *_a):
            raise OSError("storage down")

    monkeypatch.setattr(storage, "container_store", lambda _c: Broken())
    rec = recording_service.QuestionRecorder(db_session._test_factory, interview_id, RATE)
    await rec.start_question(0)
    rec.append(_pcm(1))
    await rec.close()  # logged, not raised
    assert await _rows(db_session, interview_id) == []


async def test_the_marker_is_consumed_and_never_forwarded():
    class Spy:
        started: list[int] = []

        async def start_question(self, i):
            self.started.append(i)

    spy = Spy()
    assert await handle_recording_marker({"type": "x.recording.question", "question_index": 3}, spy)
    assert await handle_recording_marker(
        {"type": "x.recording.question", "question_index": -1}, spy
    )
    assert await handle_recording_marker({"type": "x.recording.question"}, None)  # not recorded
    assert not await handle_recording_marker({"type": "response.create"}, spy)
    assert not await handle_recording_marker("text", spy)
    assert spy.started == [3]


async def test_admins_list_and_play_recordings_and_an_expired_one_is_gone(
    client, db_session, admin_auth, candidate_auth
):
    interview_id = await _interview(db_session)
    rec = recording_service.QuestionRecorder(db_session._test_factory, interview_id, RATE)
    await rec.start_question(0)
    rec.append(_pcm(1))
    await rec.close()
    base = f"/admin/interviews/{interview_id}/recordings"

    listed = (await client.get(base, headers=admin_auth)).json()
    assert [(r["question_index"], r["duration_ms"]) for r in listed] == [(0, 1000)]
    audio = await client.get(f"{base}/{listed[0]['recording_id']}", headers=admin_auth)
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"
    assert audio.content[:4] == b"RIFF"

    assert (await client.get(base, headers=candidate_auth)).status_code == 403
    assert (await client.get(f"{base}/nope", headers=admin_auth)).status_code == 404
    assert (
        await client.get("/admin/interviews/nope/recordings", headers=admin_auth)
    ).status_code == 404

    row = await db_session.get(InterviewRecording, listed[0]["recording_id"])
    import os

    os.remove(row.blob_path)  # the retention period deleted it
    gone = await client.get(f"{base}/{row.id}", headers=admin_auth)
    assert gone.status_code == 410


async def test_the_interview_tells_the_candidate_whether_answers_are_recorded(monkeypatch):
    from app.config import get_settings

    assert recording_service.recording_enabled() is True
    assert recording_service.retention_days() == 90
    monkeypatch.setattr(get_settings(), "candidate_audio_recording", False)
    assert recording_service.recording_enabled() is False
