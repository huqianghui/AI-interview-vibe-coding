"""Per-persona Foundry IQ knowledge-base config (SPEC F5) — one row per attached KB.

Each interviewer persona binds its OWN knowledge bases (no global KB): an admin picks an Azure AI
Search connection + a Foundry IQ knowledge base in the editor, and each attachment becomes an
``MCPTool`` on that persona's Foundry prompt agent (see app.services.agents.knowledge_tool +
app.services.agents.adapters.azure_agent_sync). Ported in shape from the reference project's
``HcpKnowledgeConfig``, retargeted to ``interviewer_personas``.

``connection_target`` is the Search endpoint URL (the KB's MCP endpoint is derived from it +
``index_name``); ``index_name`` is the Foundry IQ knowledge-base name; ``server_label`` is the
MCPTool label (defaulted from the index). Deleting a persona cascades its KB rows.
"""

from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.mixins import TimestampMixin


class PersonaKnowledgeConfig(TimestampMixin, Base):
    __tablename__ = "persona_knowledge_configs"

    persona_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("interviewer_personas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Azure AI Search connection name (as listed by the project client).
    connection_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Search endpoint URL; the KB MCP endpoint is built from this + index_name.
    connection_target: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    # Foundry IQ knowledge-base name.
    index_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # MCPTool label; defaulted to f"knowledge-base-{index_name}" in the service.
    server_label: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
