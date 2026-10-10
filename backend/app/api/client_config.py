"""Runtime configuration for the browser.

The SPA is one image deployed into many environments (our own and each client's tenant), so values
that differ per deployment cannot be baked into the bundle at build time. The page reads them here
once at start-up.

Today that is only the Application Insights connection string, which the backend already has (the
deployment injects ``APPLICATIONINSIGHTS_CONNECTION_STRING``). It is an ingestion-only key, designed
by Azure Monitor to sit in a browser, so this route needs no login. Without it the page sends no
telemetry at all.
"""

import os

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/public", tags=["client-config"])


class ClientConfig(BaseModel):
    app_insights_connection_string: str | None = None


@router.get("/client-config", response_model=ClientConfig)
async def client_config() -> ClientConfig:
    connection = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING", "").strip()
    return ClientConfig(app_insights_connection_string=connection or None)
