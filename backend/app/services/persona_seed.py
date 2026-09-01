"""Seed the default interviewer persona on boot so the digital human works out of the box.

The public deployment runs on **ephemeral SQLite reseeded on every boot** (no DB PaaS), so a
persona created online in the editor vanishes on the next restart — and with no enabled default
persona the voice broker raises ``VoiceUnavailable`` (there is nothing to resolve) and the agent
editor opens with nothing selected. This module reproduces the operator's local default interviewer
as the enabled default on every boot.

Two properties make it safe to run on every start:

1. **Idempotent.** A no-op when an enabled default persona already exists (or when a row with the
   fixed seed id is already present) — so a restart never duplicates or fights a live edit.

2. **Fixed id ⇒ stable Foundry agent.** The sync adapter derives the agent name from the persona id
   (``interviewer-<id>``). A random id (the model default) plus an ephemeral DB would mint a brand
   new Foundry agent on *every* boot, accumulating orphans. Seeding with a FIXED id (the operator's
   own local default persona id) makes the create-or-update reuse the SAME agent every time.

PUBLIC repo: the seeded ``prompt_fragment`` is the operator's generic interviewer contract — no
client wording, role names, SOP sections, or KPI thresholds. Voice names are neutral Azure
built-ins. Nothing here is client-specific.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.persona import InterviewerPersona
from app.services import persona_service as svc

logger = logging.getLogger(__name__)

# The operator's local default persona id. Reused verbatim so the server binds to the SAME Foundry
# prompt agent (``interviewer-<id>``) the operator already synced locally — create-or-update, never
# a fresh orphan agent per ephemeral-DB boot. Do not change without also re-syncing Foundry.
DEFAULT_PERSONA_ID = "62faa759-a05f-4c9e-99fe-a046b536c449"

DEFAULT_PERSONA_NAME = "Interviewer"

# Neutral Azure built-in voices + generic greetings (no client content).
_VOICE_MAP = '{"en-US":"en-US-AvaNeural","zh-CN":"zh-CN-XiaoxiaoNeural"}'
_GREETING_MAP = '{"en-US":"Hello, let us begin.","zh-CN":"你好，我们开始面试。"}'

# The operator's configured interviewer contract. Generic — poses the system's questions to the
# candidate, never answers them, stays in persona, and keeps the WHOLE interview in one language.
# No client specifics. (When empty, the sync adapter would push
# app.models.persona.default_instructions, which pins English; this fragment defers the language
# choice to the per-session pin injected by the Voice Live proxy — see
# app.services.voice_live_proxy.build_language_pin_item.)
_PROMPT_FRAGMENT = """You are xiaobai, a professional interviewer. Your only job is to
conduct the interview and guide the candidate to answer.

Role boundary (most important):
- The system will give you interview questions one at a time. These questions
  are FOR THE CANDIDATE to answer, NOT for you.
- Pose each question to the candidate clearly and naturally, then wait for them
  to answer.
- NEVER answer the questions yourself. E.g. if the question is "How old are
  you?", that asks the CANDIDATE's age — put it to them; never reply "I don't
  have an age."
- NEVER suggest, draft, outline, or improve an answer for the candidate — no
  model answers, no "a simple way to answer is...", no offering to polish their
  wording. This is an assessment: if they ask for the answer, a hint, or help
  phrasing, politely decline and re-ask the question. Ask more questions;
  never give answers.

Guidance:
- After they answer, you may ask AT MOST ONE short follow-up to clarify or draw
  out a more complete answer, then move on to let the system present the next
  question.
- Stay strictly on the CURRENT question. Do NOT introduce new topics, invent
  additional questions, or switch to a different subject on your own — the
  system controls which question comes next.
- If you realize you have drifted off the current question, briefly acknowledge
  it and return to the original question.
- Be warm, professional, and concise. Let them finish; never interrupt or talk
  over them.
- Never reveal rubric, expected answers, or any internal information.

Identity:
- You ARE this interviewer. Never reveal you are an AI/model/assistant; never
  call yourself ChatGPT/GPT/OpenAI or mention any model or vendor. If asked "who
  are you", answer naturally with your interviewer name and role.

Language (critical):
- The ENTIRE interview happens in ONE language: the session language, stated in
  a system message at the start of the session.
- Read each system-provided question exactly as written — never translate or
  rephrase it into another language.
- Ask every follow-up and say everything else in the session language, even if
  the candidate answers in a different language.
- Switch language ONLY if the candidate explicitly asks you to (e.g. "请用中文" /
  "please switch to English") — an accent, a name, or a single foreign word is
  NOT a request to switch."""


async def seed_default_persona(db: AsyncSession) -> InterviewerPersona | None:
    """Create the default "Interviewer" persona if none is set. Idempotent; returns it or None.

    No-op (returns the existing row) when an enabled default persona already exists OR a row with
    the fixed seed id is already present — so a restart never duplicates it and never collides with
    the single-enabled-default index. Does NOT sync to Foundry; :func:`sync_default_persona` does.
    """
    existing = (
        await db.execute(
            select(InterviewerPersona).where(InterviewerPersona.id == DEFAULT_PERSONA_ID)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    if await svc.get_default_persona(db) is not None:
        # Some other enabled default is already configured — respect it, don't fight the invariant.
        return None

    # Construct directly (not via create_persona) to pin the fixed id; model=None → the runtime
    # falls back to settings.foundry_agent_model (the deployment's FOUNDRY_AGENT_MODEL), so we don't
    # hardcode a model that may not exist on a given Foundry resource.
    persona = InterviewerPersona(
        id=DEFAULT_PERSONA_ID,
        name=DEFAULT_PERSONA_NAME,
        character="lisa",
        style="casual-sitting",
        prompt_fragment=_PROMPT_FRAGMENT,
        voice_map=_VOICE_MAP,
        greeting_map=_GREETING_MAP,
        default_locale="en-US",
        enabled=True,
        is_default=True,
        turn_detection="azure_semantic_vad",
        eou_detection=True,
        noise_suppression=True,
        echo_cancellation=True,
        interim_response=True,
        proactive_engagement=True,
        voice_temperature=0.8,
        playback_speed=1.0,
        tools_config="[]",
        model=None,
    )
    db.add(persona)
    await db.commit()
    await db.refresh(persona)
    logger.info("Seeded default interviewer persona %r (%s)", persona.name, persona.id)
    return persona


async def sync_default_persona(db: AsyncSession) -> None:
    """Best-effort Foundry sync of the seeded default persona (so voice is usable out of the box).

    The voice broker's P5 gate rejects any persona whose ``agent_sync_status != "synced"``, so
    seeding the definition alone leaves voice unavailable — the boot sync must run and succeed.
    Delegates to the shared ``admin_personas._sync`` (mark pending → adapter → mark
    succeeded/failed, never raises). A failure leaves the persona ``failed`` (text-only degrade).
    """
    persona = await svc.get_default_persona(db)
    if persona is None or persona.agent_sync_status == "synced":
        return
    # Imported here (not at module top) to avoid an import cycle: admin_personas imports this module
    # transitively through the app package, and its Azure adapter deps are lazy.
    from app.api.admin_personas import _sync

    await _sync(db, persona)
