"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.api import candidate_session, health
from app.config import get_settings

settings = get_settings()

app = FastAPI(title=settings.app_name, debug=settings.debug)

app.include_router(health.router)
app.include_router(candidate_session.router)
