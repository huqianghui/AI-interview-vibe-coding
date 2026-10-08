"""Candidate voice recordings: the microphone only, one WAV per question, kept 90 days.

The browser already streams the candidate's microphone to the backend's Voice Live proxy as raw
PCM16 (``voice_live_proxy._forward_client_to_azure``), so recording costs no extra upload: the
proxy hands each frame to a :class:`QuestionRecorder` as it forwards it. The interview page sends
a marker, ``{"type": "x.recording.question", "question_index": n}``, when a question starts; the
proxy keeps it (Azure never sees it) and the recorder starts that question's file. Nothing is kept
before the first marker, and the editor Playground is never recorded.

Files go to the private ``recordings`` container, whose lifecycle rule deletes them after
``recording_retention_days`` (infra/azure/modules/storage.bicep). Only an admin can play one, and
only through the backend (``app/api/admin_interviews.py``). A recording failure is logged and
dropped: it never interrupts the interview.
"""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
import wave
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.interview import InterviewRecording
from app.services import storage

logger = logging.getLogger(__name__)

MARKER_TYPE = "x.recording.question"
# Shorter than this is a cough or a click, not an answer.
MIN_RECORDING_MS = 500
# One question's audio is held in memory until the next one starts: 10 minutes at 16 kHz is 19 MB.
# An answer longer than that keeps its first 10 minutes.
MAX_RECORDING_SECONDS = 10 * 60
# Markers name a question by its 0-based index; anything above this is not a question.
MAX_QUESTION_INDEX = 500


def wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # PCM16
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return out.getvalue()


def recording_enabled() -> bool:
    return bool(get_settings().candidate_audio_recording)


def retention_days() -> int:
    return int(get_settings().recording_retention_days)


class QuestionRecorder:
    """Collects one interview's microphone audio and stores it per question."""

    def __init__(self, session_factory, interview_id: str, sample_rate: int) -> None:  # noqa: ANN001
        self._session_factory = session_factory
        self._interview_id = interview_id
        self._rate = sample_rate
        self._question: int | None = None
        self._pcm = bytearray()
        self._max_bytes = MAX_RECORDING_SECONDS * sample_rate * 2
        # Uploads run beside the relay: the next question's audio never waits for the last one's.
        self._uploads: set[asyncio.Task] = set()

    def append(self, pcm: bytes) -> None:
        if self._question is None or len(self._pcm) >= self._max_bytes:
            return
        self._pcm.extend(pcm[: self._max_bytes - len(self._pcm)])

    async def start_question(self, question_index: int) -> None:
        if question_index == self._question or not 0 <= question_index <= MAX_QUESTION_INDEX:
            return  # the same question again (a re-sent marker), or not a question
        self._hand_off()
        self._question = question_index

    async def close(self) -> None:
        """Store what is left and wait for every upload (the connection is closing anyway)."""
        self._hand_off()
        self._question = None
        if self._uploads:
            await asyncio.wait(set(self._uploads), timeout=60)

    def _hand_off(self) -> None:
        pcm, self._pcm = bytes(self._pcm), bytearray()
        if self._question is None or len(pcm) * 1000 // (self._rate * 2) < MIN_RECORDING_MS:
            return
        task = asyncio.create_task(self._store(self._question, pcm))
        self._uploads.add(task)
        task.add_done_callback(self._uploads.discard)

    async def _store(self, question_index: int, pcm: bytes) -> None:
        duration_ms = len(pcm) * 1000 // (self._rate * 2)
        key = f"{self._interview_id}/q{question_index + 1:02d}-{uuid.uuid4().hex[:8]}.wav"
        try:
            store = storage.container_store(get_settings().recording_blob_container)
            path = await asyncio.to_thread(store.save, key, wav_bytes(pcm, self._rate))
            async with self._session_factory() as db:
                db.add(
                    InterviewRecording(
                        interview_session_id=self._interview_id,
                        question_index=question_index,
                        blob_path=path,
                        duration_ms=duration_ms,
                        size_bytes=len(pcm) + 44,
                    )
                )
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a lost recording must never interrupt the interview
            logger.exception("Storing a recording of interview %s failed", self._interview_id)


async def list_recordings(db: AsyncSession, interview_id: str) -> Sequence[InterviewRecording]:
    return (
        (
            await db.execute(
                select(InterviewRecording)
                .where(InterviewRecording.interview_session_id == interview_id)
                .order_by(InterviewRecording.question_index, InterviewRecording.created_at)
            )
        )
        .scalars()
        .all()
    )


def load_audio(recording: InterviewRecording) -> bytes:
    """The WAV bytes; ``FileNotFoundError`` once the retention period has deleted it."""
    return storage.load(recording.blob_path)
