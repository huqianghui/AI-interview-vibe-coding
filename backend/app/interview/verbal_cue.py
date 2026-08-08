"""Verbal end-of-answer cue detection (SPEC F6 AC #3) — pure, provider-agnostic.

The candidate can end an answer two ways over voice (F6): a **silence timeout**, detected
natively by Voice Live end-of-utterance detection (``turn_detection.end_of_utterance_detection``,
``semantic_detection_v1_multilingual``) — that lives in the transport layer (F9), not here — and
a **verbal cue** ("我答完了" / "done"), detected in the transcript. This module owns the verbal-cue
half: recognising the phrase and stripping it from the answer content so the cue is not scored as
if it were part of the answer.

Pure string logic, no Azure and no DB — the transcript text is the only input, so it is fully
CI-tested and the same helpers work for text and voice transports.
"""

import re

# Cue phrases (zh + en). Matched case-insensitively; Chinese is case-agnostic anyway. Ordered
# longest-first within each language so we strip the fullest match (e.g. the longer zh phrase
# before its shorter suffix).
VERBAL_CUE_PHRASES: tuple[str, ...] = (
    "我说完了",
    "我答完了",
    "回答完毕",
    "答完了",
    "说完了",
    "结束",
    "i'm finished",
    "im finished",
    "i'm done",
    "im done",
    "that's all",
    "thats all",
    "finished",
    "done",
)

# A cue only counts as a terminator at the very end of the answer (optionally followed by simple
# punctuation/space), so "I'm done explaining the first step" is NOT treated as a cue.
_TRAILING = r"[\s。.!！?？,，]*"
_CUE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(rf"{re.escape(phrase)}{_TRAILING}$", re.IGNORECASE) for phrase in VERBAL_CUE_PHRASES
)


def detect_verbal_cue(text: str | None) -> bool:
    """True if ``text`` ends with a recognised end-of-answer cue phrase."""
    stripped = (text or "").strip()
    if not stripped:
        return False
    return any(pattern.search(stripped) for pattern in _CUE_PATTERNS)


def strip_verbal_cue(text: str | None) -> str:
    """Remove a trailing cue phrase from ``text`` (the substance the candidate actually gave).

    Only the final trailing cue is removed; cue-like words earlier in the answer are left intact.
    Returns the input unchanged (trimmed) when no trailing cue is present.
    """
    stripped = (text or "").strip()
    if not stripped:
        return ""
    for pattern in _CUE_PATTERNS:
        if pattern.search(stripped):
            return pattern.sub("", stripped).strip()
    return stripped
