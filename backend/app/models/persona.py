"""Interviewer digital-human persona model (SPEC F5).

Ported in shape from the reference ``AvatarPersona``: a persona is the interviewer's identity
(name, character, style), its per-locale voice + greeting maps, the prompt fragment that becomes
the Foundry agent's instructions, and the Voice Live knobs that get serialized into the agent's
``microsoft.voice-live.configuration`` metadata (see app.services.agents.voice_live_metadata).

Agent-sync bookkeeping (``agent_id`` / ``agent_version`` / ``agent_sync_status`` /
``agent_sync_error``) tracks the persona's binding to a synced Foundry prompt agent so a failed
sync is a recorded state, not a crash (SPEC F5 AC #4).

**Exactly one enabled default** is enforced at the DB level via a partial-unique index over
``is_default`` filtered to enabled defaults (SPEC F5 AC #3).

PUBLIC repo: no real persona content (client wording, voice names) is stored here — these are
schema definitions plus neutral defaults only.
"""

from sqlalchemy import Boolean, Float, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin

# Foundry agent sync lifecycle (SPEC F5): a persona is "none" until first sync is attempted.
AGENT_SYNC_STATUSES = ("none", "pending", "synced", "failed")


def default_instructions(name: str) -> str:
    """The auto-generated agent instructions used when ``prompt_fragment`` is empty.

    Single source of truth for the fallback string: the sync adapter pushes it to Foundry, and the
    editor UI displays it as the effective default — so what the operator sees in our editor always
    matches what the Foundry Portal shows, even before they've written custom instructions.

    This is a real interviewer *contract*, not a one-liner. A thin "You are an interviewer." lets
    the base model degrade into generic-assistant behavior: answering the interview questions
    itself (e.g. replying to "How old are you?" as if asked of it) and self-identifying as
    ChatGPT/OpenAI. The questions are posed TO the candidate — the agent must ASK them and guide the
    candidate, never answer them, and never break the interviewer persona. Operators can still fully
    override this by writing a custom ``prompt_fragment`` (the sync adapter uses the fragment OR
    this default, never both), so strengthening the default only hardens the never-customized case.
    """
    return (
        f"You are {name}, a professional interviewer. Your only job is to conduct the interview "
        "and guide the candidate to answer.\n\n"
        "Role boundary (most important): the system gives you interview questions one at a time. "
        "These questions are FOR THE CANDIDATE to answer, NOT for you. Pose each question to the "
        "candidate clearly and naturally, then wait for their answer. NEVER answer the questions "
        'yourself — e.g. if the question is "How old are you?", that asks the CANDIDATE\'s age; '
        'put it to them, never reply "I don\'t have an age." NEVER suggest, draft, or improve an '
        'answer for the candidate — no model answers, no "a simple way to answer is...", no '
        "offering to polish their wording. This is an assessment: if they ask for the answer, a "
        "hint, or help phrasing, politely decline and re-ask the question.\n\n"
        "Guidance: after they answer, you may ask AT MOST ONE short follow-up to clarify or draw "
        "out a more complete answer, then move on to let the system present the next question. "
        "Stay strictly on the CURRENT question — do NOT introduce new topics, invent additional "
        "questions, or switch to a different subject on your own; the system controls which "
        "question comes next. If you realize you have drifted off the current question, briefly "
        "acknowledge it and return to the original question. Be warm, professional, and concise. "
        "Let them finish; never interrupt or talk over them. Never reveal rubric, expected "
        "answers, or any internal information.\n\n"
        "Identity: you ARE this interviewer. Never reveal you are an AI, model, or assistant; "
        "never call yourself ChatGPT/GPT/OpenAI or mention any model or vendor. If asked who you "
        "are, answer naturally with your name and interviewer role.\n\n"
        "Language (critical): the ENTIRE interview happens in ONE language — the session "
        "language, stated in a system message at the start of the session (English if none is "
        "stated). Read each system-provided question exactly as written — never translate or "
        "rephrase it into another language. Ask every follow-up and say everything else in the "
        "session language, even if the candidate replies in another language. Switch ONLY if the "
        "candidate explicitly asks you to; an accent or a single foreign word is not a request "
        "to switch."
    )


class InterviewerPersona(TimestampMixin, Base):
    __tablename__ = "interviewer_personas"

    # Identity ---------------------------------------------------------------
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    character: Mapped[str] = mapped_column(Text, default="", nullable=False)
    style: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Instruction fragment injected into the Foundry prompt agent's instructions.
    prompt_fragment: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # Per-locale maps (JSON: {"zh-CN": "...", "en-US": "..."}). Stored as text to keep the
    # model backend-agnostic (SQLite dev / any prod DB); serialized/parsed in the service layer.
    voice_map: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    greeting_map: Mapped[str] = mapped_column(Text, default="{}", nullable=False)

    # The locale the editor opens on and the one whose voice/greeting the editor last edited.
    # Unlike voice_map/greeting_map (which carry BOTH locales at once), this is a single scalar so
    # the editor's "Language" selector round-trips — without it the dropdown reset to a hardcoded
    # default on every reload even after Save. Not the interview's runtime language (that's chosen
    # per session via the language-pin item); purely the persona's remembered editing locale.
    default_locale: Mapped[str] = mapped_column(
        String(16), default="zh-CN", server_default="zh-CN", nullable=False
    )

    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Voice Live knobs (serialized into voice-live.configuration metadata) -----
    # `turn_detection` is the VAD type string; the fixed EOU model + interim vocab are owned by
    # the pure metadata builder (they're API constants, not per-persona config). `eou_detection`
    # is a bool toggle — the builder emits the end_of_utterance_detection sub-object on truthiness.
    turn_detection: Mapped[str] = mapped_column(
        String(64), default="azure_semantic_vad", nullable=False
    )
    eou_detection: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    noise_suppression: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    echo_cancellation: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    interim_response: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    proactive_engagement: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    voice_temperature: Mapped[float] = mapped_column(Float, default=0.8, nullable=False)
    playback_speed: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)

    # Per-persona agent tools (SPEC F5) — JSON array of tool dicts synced into the Foundry prompt
    # agent's `tools`. Executed by the Foundry runtime, not here; this app only carries the config.
    # e.g. [{"type":"code_interpreter"},{"type":"web_search"},{"type":"mcp","server_url":...}].
    tools_config: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    # Foundry agent binding + sync bookkeeping --------------------------------
    agent_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    agent_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Per-persona model deployment. Different Foundry agent versions can run different models, so
    # the model is tracked here (not just the global master config). Nullable: null means "fall
    # back to the global foundry_agent_model". Populated on sync/reconcile with the version's model.
    model: Mapped[str | None] = mapped_column(String(100), nullable=True, default=None)
    agent_sync_status: Mapped[str] = mapped_column(String(16), default="none", nullable=False)
    agent_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def default_instructions(self) -> str:
        """The generated instructions this persona's agent gets when ``prompt_fragment`` is empty.

        Exposed to the API/editor so the UI can show the effective default instead of a blank
        field — keeping what the operator sees aligned with the Foundry Portal.
        """
        return default_instructions(self.name)

    __table_args__ = (
        # SPEC F5 AC #3: at most one enabled default persona, enforced in the DB, not app code.
        # Partial index (SQLite + Postgres both honor the WHERE clause) so only enabled defaults
        # contend for the single slot; disabled or non-default rows are unconstrained.
        Index(
            "uq_one_enabled_default_persona",
            "is_default",
            unique=True,
            sqlite_where=text("enabled = 1 AND is_default = 1"),
            postgresql_where=text("enabled = true AND is_default = true"),
        ),
    )
