"""Runtime configuration for the browser, for a signed-in user.

The SPA is one image deployed into many environments (our own and each client's tenant), so values
that differ per deployment cannot be baked into the bundle at build time. The page reads them here
after sign-in.

Today that is only the Application Insights connection string, which the backend already has (the
deployment injects ``APPLICATIONINSIGHTS_CONNECTION_STRING``). Azure Monitor does not treat it as a
secret (it only lets a client SEND telemetry, never read any), but anyone holding it can send junk
into the resource, so it is handed only to a signed-in candidate or admin rather than to anyone who
asks. A signed-in user can still copy it from the browser; that is inherent to browser telemetry.
Without it the page sends no telemetry at all.
"""

import os

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import get_current_user
from app.models.user import User

router = APIRouter(tags=["client-config"])


class ClientConfig(BaseModel):
    app_insights_connection_string: str | None = None


@router.get("/client-config", response_model=ClientConfig)
async def client_config(_user: User = Depends(get_current_user)) -> ClientConfig:
    connection = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING", "").strip()
    return ClientConfig(app_insights_connection_string=connection or None)
