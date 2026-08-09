"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.api import admin_personas, admin_sop, candidate_session, health, interview
from app.config import get_settings

settings = get_settings()

app = FastAPI(title=settings.app_name, debug=settings.debug)

app.include_router(health.router)
app.include_router(candidate_session.router)
app.include_router(interview.router)
app.include_router(admin_personas.router)
app.include_router(admin_sop.router)
