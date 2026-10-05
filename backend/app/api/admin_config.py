"""Admin Azure config editor — the runtime source of truth for the AI Foundry connection.

An operator enters the AI Foundry endpoint / API key / project / model here; it's saved (key
encrypted) to the ``service_configs`` master row and overlaid onto the settings singleton so it
takes effect immediately (no restart) — see ``app.services.config_overlay``. This is what lets
production read the user's own config instead of ``.env``.

All routes require an admin JWT (``require_role("admin")`` — Phase 1 auth, same guard as the other
admin routers). The API key is write-only: responses return only a masked value, never the token.
"""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import require_role
from app.services import config_service
from app.services.agents import foundry_connections
from app.services.config_overlay import apply_master_config_to_settings
from app.services.config_service import InvalidEndpointError

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/admin/config", tags=["admin-config"], dependencies=[Depends(require_role("admin"))]
)


class AiFoundryConfigIn(BaseModel):
    endpoint: str = Field(default="", max_length=500)
    # Write-only. Empty preserves the existing stored key (so saving from the masked UI is safe).
    api_key: str = ""
    # True deletes the stored key — the connection then authenticates with Entra ID / Managed
    # Identity only. Wins over api_key.
    clear_api_key: bool = False
    default_project: str = Field(default="", max_length=200)
    # The INFERENCE model: judge, scoring, checklist drafting, SOP coverage, and the Foundry
    # agent's own model. A deployment name in this resource.
    model_or_deployment: str = Field(default="", max_length=100)
    # The Voice Live SESSION model, separate because its legal values are a different set (see
    # ServiceConfig). Empty falls back to VOICE_LIVE_DEFAULT_MODEL.
    voice_model: str = Field(default="", max_length=100)
    voice_model_mode: str = Field(default="native", max_length=16)
    voice_byom_profile: str = Field(default="", max_length=64)
    knowledge_base: str = Field(default="", max_length=200)
    knowledge_source: str = Field(default="", max_length=200)


class AiFoundryConfigOut(BaseModel):
    endpoint: str
    masked_key: str
    default_project: str
    model_or_deployment: str
    voice_model: str
    voice_model_mode: str
    voice_byom_profile: str
    knowledge_base: str
    knowledge_source: str
    is_active: bool
    # What the save-time live check concluded about the voice model. Informational: a definitive
    # rejection never reaches here (it is a 422), and "could not check" still saves.
    voice_model_check: str = ""


class ConnectionTestResult(BaseModel):
    success: bool
    message: str


class Option(BaseModel):
    value: str
    label: str


def _to_out(master, masked_key: str, voice_model_check: str = "") -> AiFoundryConfigOut:
    if master is None:
        return AiFoundryConfigOut(
            endpoint="",
            masked_key="",
            default_project="",
            model_or_deployment="",
            voice_model="",
            voice_model_mode="native",
            voice_byom_profile="",
            knowledge_base="",
            knowledge_source="",
            is_active=False,
        )
    return AiFoundryConfigOut(
        endpoint=master.endpoint,
        masked_key=masked_key,
        default_project=master.default_project,
        model_or_deployment=master.model_or_deployment,
        voice_model=master.voice_model,
        voice_model_mode=master.voice_model_mode,
        voice_byom_profile=master.voice_byom_profile,
        knowledge_base=master.knowledge_base,
        knowledge_source=master.knowledge_source,
        is_active=master.is_active,
        voice_model_check=voice_model_check,
    )


@router.get("/ai-foundry", response_model=AiFoundryConfigOut)
async def get_ai_foundry_config(db: AsyncSession = Depends(get_db)) -> AiFoundryConfigOut:
    """Return the saved master AI Foundry config with a masked key (empty if never configured)."""
    master = await config_service.get_master_config(db)
    key = await config_service.get_decrypted_key(db)
    return _to_out(master, config_service.mask_key(key))


async def _production_voice_session(db: AsyncSession, *, realtime_pipeline: bool = False) -> Any:
    """The session shape a real interview sends, so the save-time check validates THAT.

    A minimal probe session is a false green: measured, ``gpt-realtime-2.1`` under
    ``byom-azure-openai-realtime`` accepts ``RequestSession(instructions="probe")`` and rejects the
    production session with "Text-based end-of-utterance detection requires a local speech
    recognizer" — speech-native passthrough has no Voice Live recognizer for text EOU or
    ``azure-speech`` transcription. Checking the minimal shape would let an operator save a config
    under which EVERY interview fails.

    Built from the default persona when there is one, so the avatar/voice/VAD block matches what the
    candidate session will actually carry. Returns ``None`` (the probe then falls back to minimal)
    if the shape cannot be built — a missing azure extra, or no persona yet on a fresh install.
    """
    try:
        from app.services.persona_service import get_default_persona
        from app.services.voice_live_proxy import build_avatar_session

        persona = await get_default_persona(db)
        if persona is None:
            return None
        session = build_avatar_session(
            persona,
            locale=None,
            playground=False,
            background=None,
            realtime_pipeline=realtime_pipeline,
        )
        # Strip the avatar before probing. AVATAR creation is rate-limited to roughly 3 per 60s
        # (measured), so probing WITH it would make every config save consume a slot and compete
        # with real candidates — and it is unnecessary: the incompatibility this check must catch
        # lives in turn_detection / input_audio_transcription, and the bisect shows "full session
        # minus avatar" still returns the end-of-utterance refusal under speech-native passthrough.
        try:
            del session["avatar"]
        except (KeyError, TypeError):
            pass
        return session
    except Exception as exc:  # noqa: BLE001 — shape-building must never break a save
        logger.warning("Could not build the production voice session for the check: %s", exc)
        return None


async def _check_voice_model(
    *, endpoint: str, api_key: str, voice_model: str, mode: str, profile: str, session: Any = None
) -> str:
    """Live-check a chosen voice model, returning a note. Raises 422 on a DEFINITIVE rejection.

    Why a real connection and not a lookup: no API lists the Voice Live models live in a region, and
    the docs table runs ahead of rollout, so the service itself is the only authority
    (``app.services.voice_live_probe``).

    What this can decide (all measured, docs/voice-live-model-support.md §4.4):

    * native — decisive. A name outside the region's catalogue answers "not supported in this
      region", so a bad choice is caught here and never reaches an interview.
    * byom — catches a wrong ``profile`` and a protocol mismatch, but **cannot** tell whether the
      deployment exists: a nonexistent name connects fine. That guarantee comes from the deployment
      dropdown (the resource's real deployments), not from this probe.

    Anything inconclusive (timeout, no credential, network) SAVES with a note. Blocking a save on
    "we could not reach Azure" would make the admin page unusable offline, and every other discovery
    path in this module fails soft the same way.
    """
    from app.config import get_settings
    from app.services import voice_live_probe as probe

    if not endpoint or not voice_model:
        return ""
    try:
        credential = await _voice_probe_credential(api_key)
    except Exception as exc:  # noqa: BLE001 — no credential at all (CI, offline, keyless + no az)
        logger.warning("Voice model check skipped (no credential): %s", exc)
        return f"Could not verify {voice_model} (no credential); saved anyway."
    result = await probe.probe_model(
        endpoint=endpoint,
        credential=credential,
        api_version=get_settings().voice_live_api_version,
        model=voice_model,
        byom_profile=profile if mode == "byom" else "",
        session=session,
    )
    verdict, detail = result["verdict"], result["detail"]
    if probe.is_definitive_rejection(verdict):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    if verdict == probe.ACCEPTED:
        return f"Voice model {voice_model} verified against the live service."
    logger.warning("Voice model check inconclusive (%s): %s", verdict, detail)
    return f"Could not verify {voice_model} ({verdict}); saved anyway."


async def _voice_probe_credential(api_key: str):
    """The credential the live proxy would use (Entra first, saved key as fallback)."""
    from app.services.voice_live_proxy import _resolve_voice_live_credential

    credential, _is_entra = await _resolve_voice_live_credential(api_key)
    return credential


@router.put("/ai-foundry", response_model=AiFoundryConfigOut)
async def update_ai_foundry_config(
    body: AiFoundryConfigIn, db: AsyncSession = Depends(get_db)
) -> AiFoundryConfigOut:
    """Save the master config, commit, then overlay it onto settings so it takes effect now.

    A changed VOICE model is live-checked before the commit, so a region-rejected choice is a 422
    and never lands in the row (the whole point of the split: whatever an operator can save must be
    connectable). The inference model is not probed here — it has nothing to do with Voice Live.
    """
    from app.services import voice_live_probe as probe

    prior = await config_service.get_master_config(db)
    voice_changed = prior is None or (
        (prior.voice_model, prior.voice_model_mode, prior.voice_byom_profile)
        != (body.voice_model, body.voice_model_mode, body.voice_byom_profile)
    )
    if body.voice_model_mode == "byom" and not body.voice_model.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Bring-your-own-model needs a deployment name for the voice session.",
        )

    try:
        master = await config_service.upsert_master_config(
            db,
            endpoint=body.endpoint,
            api_key=body.api_key,
            clear_api_key=body.clear_api_key,
            default_project=body.default_project,
            model_or_deployment=body.model_or_deployment,
            voice_model=body.voice_model,
            voice_model_mode=body.voice_model_mode,
            voice_byom_profile=body.voice_byom_profile,
            knowledge_base=body.knowledge_base,
            knowledge_source=body.knowledge_source,
            updated_by="admin",
        )
    except InvalidEndpointError as exc:
        # Reject a non-Azure endpoint (key-exfil / SSRF guard) as a 422, without touching the row.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    check = ""
    if voice_changed:
        # The upsert only flushed, so a rejection here rolls the row back untouched. Probing after
        # the upsert also means the endpoint has already passed validate_endpoint.
        effective_key = body.api_key or (await config_service.get_decrypted_key(db) or "")
        try:
            check = await _check_voice_model(
                endpoint=body.endpoint,
                api_key="" if body.clear_api_key else effective_key,
                voice_model=body.voice_model.strip(),
                mode=body.voice_model_mode,
                profile=body.voice_byom_profile.strip(),
                # Build it for the pipeline the SAVED model implies, or the check validates a
                # shape the app would never send — the false green this check exists to remove.
                session=await _production_voice_session(
                    db,
                    realtime_pipeline=probe.uses_realtime_pipeline(
                        body.voice_model.strip(),
                        body.voice_byom_profile.strip() if body.voice_model_mode == "byom" else "",
                    ),
                ),
            )
        except HTTPException:
            await db.rollback()
            raise

    await db.commit()
    await db.refresh(master)

    # Apply immediately (overlay onto settings + re-register azure adapters).
    await apply_master_config_to_settings(db)

    key = await config_service.get_decrypted_key(db)
    return _to_out(master, config_service.mask_key(key), check)


@router.post("/ai-foundry/test", response_model=ConnectionTestResult)
async def test_ai_foundry_config(db: AsyncSession = Depends(get_db)) -> ConnectionTestResult:
    """Lightweight connectivity probe against the effective Foundry connection (DB row, .env fill).

    Auth mirrors the runtime strategy (``azure_auth``): Entra bearer first (az login / Managed
    Identity), saved API key as fallback — so a blank key passes on key-disabled resources. Probes
    the project deployments API when a project is set (the legacy ``/openai/deployments`` path
    404s on ``services.ai.azure.com`` resources regardless of auth), else the legacy path. Never
    raises: returns a structured pass/fail either way, naming the auth that succeeded.
    """
    # Imported lazily like the other azure_auth users to keep module import light for tests.
    from app.services.azure_auth import FOUNDRY_SCOPE, get_bearer_token

    endpoint, project, api_key, _model = await config_service.resolve_foundry_connection(db)
    if not endpoint:
        return ConnectionTestResult(success=False, message="AI Foundry not configured.")

    bearer = await get_bearer_token(FOUNDRY_SCOPE)
    if not bearer and not api_key:
        return ConnectionTestResult(
            success=False,
            message=(
                "No credential: Entra ID unavailable (az login / Managed Identity) "
                "and no API key saved."
            ),
        )

    base = endpoint.rstrip("/")
    if project:
        url = f"{base}/api/projects/{project}/deployments?api-version=v1"
    else:
        url = f"{base}/openai/deployments?api-version=2024-10-21"

    attempts = [
        a
        for a in (
            ("Entra ID", {"Authorization": f"Bearer {bearer}"}) if bearer else None,
            ("API key", {"api-key": api_key}) if api_key else None,
        )
        if a
    ]
    failures: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for auth_label, headers in attempts:
                resp = await client.get(url, headers=headers)
                if resp.status_code == 200:
                    return ConnectionTestResult(
                        success=True, message=f"Connection succeeded ({auth_label})."
                    )
                hint = " — check the project name" if resp.status_code == 404 and project else ""
                failures.append(f"{auth_label}: {resp.status_code}{hint}")
        return ConnectionTestResult(success=False, message=f"Failed — {'; '.join(failures)}.")
    except httpx.HTTPError as exc:
        return ConnectionTestResult(success=False, message=f"Connection failed: {exc}")


# Which deployments are legal for which consumer. The INFERENCE model and the chat-completion BYOM
# profile need a chat deployment; the realtime BYOM profile needs a realtime one; the Anthropic
# profile needs a Claude one. Offering the wrong kind is how an operator configures something that
# cannot work, so the dropdown filters instead of listing everything.
DEPLOYMENT_KINDS = ("chat", "realtime", "all")


def _deployment_options(items: list[dict], kind: str = "chat") -> list[Option]:
    """Map Foundry project-API deployment items to dropdown options, filtered by ``kind``.

    Measured against the real resource (2026-10-05): the project deployments API returns 18 items
    whose ``capabilities`` only ever carry the keys ``chat_completion``, ``completion`` and
    ``embeddings`` — **there is no positive "realtime" flag**. A realtime deployment looks like
    ``{"chat_completion": "false", "completion": "false"}``, identical in shape to anything else
    that is neither chat nor embeddings. So realtime is identified NEGATIVELY. That is a
    measurement, not a guess, and it is why this cannot simply key off a capability name.

    * ``chat`` (default) — ``chat_completion == "true"``. What the Portal's agent model dropdown
      shows, and what judge / scoring / the Foundry agent need. Back-compatible default: callers
      that predate the BYOM split keep the old behaviour.
    * ``realtime`` — declares ``chat_completion`` and declares it ``"false"``, and is not an
      embedding. The "declares it" half is load-bearing and also measured: a realtime deployment
      carries ``{"chat_completion": "false", "completion": "false"}`` while the resource's image
      deployment (``gpt-image-2-1``) carries an **empty** ``capabilities: {}``. Filtering on
      "not chat" alone therefore offered the image model too — caught by running the real endpoint,
      not by the unit test. On this resource the rule now yields exactly ``gpt-realtime-1.5`` /
      ``gpt-realtime-2.1``, both live-verified to connect under ``byom-azure-openai-realtime``.
      Without any of this, a chat-only list made that profile **unreachable from the UI** even
      though the path works.
    * ``all`` — every named deployment. This is what the **Anthropic** profile uses, deliberately:
      Claude cannot be deployed in this tenant, so there is no way to measure how a Claude
      deployment is labelled, and an invented filter that guessed wrong would leave that
      dropdown EMPTY — the exact bug this function is fixing for realtime. A too-wide list is
      recoverable (the operator picks from real deployments, and the save-time probe rejects a bad
      pairing); a too-narrow one makes the profile unreachable. So: no unverified filter.

    The realtime rule can still be too wide — a future type that also declares
    ``chat_completion: "false"`` would land in it — and that stays the deliberate direction:
    too wide beats too narrow, because Azure rejects a bad pairing at connect
    (``byom_realtime_connection_error``, measured) while an empty dropdown has no recourse.

    If the capability field is absent on every item (older API shape) the chat filter falls back to
    listing everything rather than an empty dropdown.
    """

    def cap(d: dict, name: str) -> str:
        return str((d.get("capabilities") or {}).get(name, ""))

    named = [d for d in items if d.get("name")]
    if kind == "all":
        picked = named
    elif kind == "realtime":
        picked = [
            d
            for d in named
            if (d.get("capabilities") or {}).get("chat_completion") is not None
            and cap(d, "chat_completion") != "true"
            and cap(d, "embeddings") != "true"
        ]
    else:
        chat = [d for d in named if cap(d, "chat_completion") == "true"]
        picked = chat or named
    return [
        Option(value=d["name"], label=f"{d['name']} ({d.get('modelName', '')})") for d in picked
    ]


@router.get("/ai-foundry/model-deployments", response_model=list[Option])
async def list_model_deployments(
    kind: str = Query(
        default="chat",
        description="which deployments are legal for the consumer asking: chat | realtime | all",
    ),
    db: AsyncSession = Depends(get_db),
) -> list[Option]:
    """List the resource's real model deployments for the config-page dropdown.

    ``kind`` selects the filter (see :func:`_deployment_options`). It defaults to ``chat`` so the
    inference-model dropdown and the per-persona editor keep their behaviour; the BYOM voice
    dropdown passes the kind its profile needs. An unknown value falls back to ``chat`` rather
    than erroring — a dropdown that 422s is worse than one showing the safe default.

    Tries the AI Foundry project-scoped deployments API (Entra bearer first — key auth is disabled
    on this resource class and 403s; api-key as fallback), then the legacy Azure OpenAI deployments
    API, then falls back to the saved model. Fail-soft: any error → saved model or []; never 500.
    """
    # Imported lazily like the other azure_auth users to keep module import light for tests.
    from app.services.azure_auth import FOUNDRY_SCOPE, get_bearer_token

    if kind not in DEPLOYMENT_KINDS:
        logger.warning("Unknown deployment kind %r; falling back to 'chat'", kind)
        kind = "chat"

    # Resolve from the saved master row, falling back to .env when no row exists yet (a fresh
    # deploy has creds only in .env). Without this fallback the dropdown is empty on day one.
    endpoint, project, api_key, model = await config_service.resolve_foundry_connection(db)
    if endpoint:
        base = endpoint.rstrip("/")
        # Entra-first: same pattern as KB discovery — key-disabled Foundry resources reject
        # api-key with 403 AuthenticationTypeDisabled, so try the bearer before the key.
        bearer = await get_bearer_token(FOUNDRY_SCOPE)
        header_attempts = [
            h
            for h in (
                {"Authorization": f"Bearer {bearer}"} if bearer else None,
                {"api-key": api_key} if api_key else None,
            )
            if h
        ]
        async with httpx.AsyncClient(timeout=10.0) as client:
            if project:
                for headers in header_attempts:
                    try:
                        url = f"{base}/api/projects/{project}/deployments?api-version=v1"
                        r = await client.get(url, headers=headers)
                        if r.status_code == 200:
                            body = r.json()
                            items = body.get("data", body.get("value", []))
                            out = _deployment_options(items, kind)
                            if out:
                                return out
                        else:
                            logger.warning(
                                "Foundry deployments API returned %d (%s auth)",
                                r.status_code,
                                "bearer" if "Authorization" in headers else "api-key",
                            )
                    except (httpx.HTTPError, KeyError, ValueError) as exc:
                        logger.warning("Foundry deployments API failed: %s", exc)
            for headers in header_attempts:
                try:
                    url = f"{base}/openai/deployments?api-version=2024-10-21"
                    r = await client.get(url, headers=headers)
                    if r.status_code == 200:
                        return [
                            Option(value=d["id"], label=f"{d['id']} ({d.get('model', '')})")
                            for d in r.json().get("data", [])
                            if d.get("id")
                        ]
                except (httpx.HTTPError, KeyError, ValueError) as exc:
                    logger.warning("Azure OpenAI deployments API failed: %s", exc)
    # Last resort: the configured model name (from DB or .env) as a single option.
    if model:
        return [Option(value=model, label=model)]
    return []


@router.get("/ai-foundry/voice-live-models", response_model=list[Option])
async def list_voice_live_models(
    refresh: bool = Query(default=False, description="re-probe instead of using the cached result"),
    db: AsyncSession = Depends(get_db),
) -> list[Option]:
    """List the NATIVE Voice Live models this resource's REGION actually accepts.

    These are Azure-hosted (path ①): Voice Live pre-deploys them on its own side, which is why
    they need no deployment of yours — and equally why they are NOT usable by judge / scoring /
    the agent, who address models by deployment name. That asymmetry is the reason the voice model
    is a separate setting from the inference model.

    The list is measured, not looked up: there is no "native models in region X" API and the Learn
    table runs ahead of rollout (``gpt-5.6-luna`` was rejected on 2026-09-23 and accepted on
    2026-10-05 on this very resource). Results are cached ~6h per endpoint; ``refresh=1`` re-probes
    (23 candidates in ~10s measured, concurrency 6).

    Fail-soft like the sibling dropdown routes: any error logs and returns [] rather than 500, and
    the page then shows guidance instead of a free-text box — a free-text box is exactly how an
    unsupported model got saved in the first place.
    """
    from app.config import get_settings
    from app.services import voice_live_probe as probe

    endpoint, _project, api_key, _model = await config_service.resolve_foundry_connection(db)
    if not endpoint:
        return []
    try:
        accepted = await probe.list_native_models(
            endpoint=endpoint,
            api_key=api_key,
            api_version=get_settings().voice_live_api_version,
            refresh=refresh,
        )
    except Exception as exc:  # noqa: BLE001 — discovery is best-effort; never 500 the admin page
        logger.warning("Voice Live native probe failed: %s", exc)
        return []
    return [Option(value=m, label=m) for m in accepted]


@router.get("/ai-foundry/knowledge-bases", response_model=list[Option])
async def list_knowledge_bases(db: AsyncSession = Depends(get_db)) -> list[Option]:
    """List the resource's Foundry IQ knowledge bases for the config-page dropdown.

    Delegates to :func:`foundry_connections.list_knowledge_bases` (Phase 2.2) — the shared
    discovery path (resolve the AI Search connection via the project client, then call the Search
    data-plane API with Entra-first / api-key-fallback auth). Fail-soft: any error → []; never 500.
    """
    endpoint, project, api_key, _model = await config_service.resolve_foundry_connection(db)
    if not endpoint:
        return []
    kbs = await foundry_connections.list_knowledge_bases(
        endpoint=endpoint, project=project, api_key=api_key
    )
    return [
        Option(value=kb["name"], label=kb.get("description") or kb["name"])
        for kb in kbs
        if kb.get("name")
    ]
