"""Per-persona knowledge-base config lifecycle (SPEC F5) — DB-only, CI-covered.

CRUD for the KB attachments an admin makes in the Agent editor's Knowledge section (one
``PersonaKnowledgeConfig`` row per attached Foundry IQ knowledge base). The Foundry-facing sync
(resolving the RemoteTool connection, building MCPTools, calling ``create_version``) is NOT here —
that lives in the coverage-omitted azure adapter; this module is pure DB + a pure
``configs_as_dicts`` shape helper the adapter consumes.
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.persona_knowledge import PersonaKnowledgeConfig


class PersonaKnowledgeError(Exception):
    """Base class for persona-knowledge-service errors."""


class PersonaKnowledgeNotFound(PersonaKnowledgeError):
    """Raised when a knowledge-config id does not exist."""


async def list_configs(db: AsyncSession, persona_id: str) -> Sequence[PersonaKnowledgeConfig]:
    """Every KB config attached to a persona, oldest first."""
    stmt = (
        select(PersonaKnowledgeConfig)
        .where(PersonaKnowledgeConfig.persona_id == persona_id)
        .order_by(PersonaKnowledgeConfig.created_at)
    )
    return (await db.execute(stmt)).scalars().all()


async def add_config(
    db: AsyncSession,
    persona_id: str,
    *,
    connection_name: str,
    connection_target: str,
    index_name: str,
) -> PersonaKnowledgeConfig:
    """Attach a KB to a persona; ``server_label`` defaults to ``knowledge-base-{index_name}``."""
    config = PersonaKnowledgeConfig(
        persona_id=persona_id,
        connection_name=connection_name,
        connection_target=connection_target,
        index_name=index_name,
        server_label=f"knowledge-base-{index_name}",
        is_enabled=True,
    )
    db.add(config)
    await db.commit()
    await db.refresh(config)
    return config


async def get_config(db: AsyncSession, config_id: str) -> PersonaKnowledgeConfig:
    config = (
        await db.execute(
            select(PersonaKnowledgeConfig).where(PersonaKnowledgeConfig.id == config_id)
        )
    ).scalar_one_or_none()
    if config is None:
        raise PersonaKnowledgeNotFound(config_id)
    return config


async def remove_config(db: AsyncSession, config_id: str) -> PersonaKnowledgeConfig:
    """Delete a KB config; return the removed row (its ``persona_id`` drives the re-sync)."""
    config = await get_config(db, config_id)
    await db.delete(config)
    await db.commit()
    return config


def configs_as_dicts(configs: Sequence[PersonaKnowledgeConfig]) -> list[dict[str, Any]]:
    """Pure shape the azure adapter consumes to resolve+build one MCPTool per KB.

    Only the fields the adapter needs (endpoint, KB name, MCPTool label, enabled flag) — no ORM
    objects cross the service boundary, so the adapter stays testable without a DB session.
    """
    return [
        {
            "connection_target": c.connection_target,
            "index_name": c.index_name,
            "server_label": c.server_label,
            "is_enabled": c.is_enabled,
        }
        for c in configs
    ]


__all__ = [
    "PersonaKnowledgeError",
    "PersonaKnowledgeNotFound",
    "add_config",
    "configs_as_dicts",
    "get_config",
    "list_configs",
    "remove_config",
]
