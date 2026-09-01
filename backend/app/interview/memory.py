"""Session-memory surfacing for follow-up prompts (SPEC F7) — pure, provider-agnostic.

The F7 demo moment: the interviewer's follow-up visibly references what the candidate JUST said,
so the room sees the agent is actually listening across turns (not asking a canned probe). This
module owns the pure text synthesis; the state machine calls it when it records a follow-up turn,
and the recorded turn's content IS the memory citation (AC #2: accurate to what the candidate
actually said, sourced from ``interview_turn``).

Voice interviews additionally get this "for free" from the Foundry prompt-agent's built-in
conversation memory (F5 persona → agent); this text synthesis is the deterministic, transport-
agnostic version that also drives the text channel and CI.
"""

from __future__ import annotations

# Longest snippet of the prior answer we quote back, so the follow-up stays readable.
_MAX_SNIPPET_CHARS = 80


def _snippet(prior_answer: str) -> str:
    """A short, clean quote of the candidate's prior answer for the follow-up to reference."""
    text = " ".join((prior_answer or "").split())  # collapse whitespace/newlines
    if len(text) <= _MAX_SNIPPET_CHARS:
        return text
    # Cut at a word boundary within the limit, then ellipsize.
    cut = text[:_MAX_SNIPPET_CHARS].rsplit(" ", 1)[0] or text[:_MAX_SNIPPET_CHARS]
    return f"{cut}…"


def build_follow_up_prompt(base_prompt: str, prior_answer: str, *, locale: str = "en-US") -> str:
    """Compose a follow-up that cites the candidate's prior answer, then asks the base probe.

    Falls back to the bare ``base_prompt`` when there's no prior answer to reference (so an empty
    main answer never yields a hollow "you said ''…" citation). Bilingual lead-in by ``locale``.
    """
    snippet = _snippet(prior_answer)
    if not snippet:
        return base_prompt
    if locale.startswith("zh"):
        return f"你刚才提到「{snippet}」——{base_prompt}"
    return f'You mentioned "{snippet}" — {base_prompt}'
