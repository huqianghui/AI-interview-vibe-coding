"""The committed OpenAPI snapshot the frontend's API types are checked against.

``frontend/src/api/openapi.json`` is this app's schema, rendered by :func:`render`;
``frontend/src/api/schema.d.ts`` is generated from it by ``npm run gen:api``, and the hand-written
API types must stay a refinement of those generated ones (``frontend/src/api/contract.check.ts``).
``tests/test_openapi_snapshot.py`` fails when a route or schema change was not re-exported, so the
frontend cannot drift from a backend shape without the type check seeing it.
"""

import json
from pathlib import Path

SNAPSHOT_PATH = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "openapi.json"


def render() -> str:
    """The app's OpenAPI document as stable, diff-friendly JSON.

    ``info`` is pinned: its title comes from ``APP_NAME``, which would make the snapshot depend on
    the environment that renders it, and the API's shape is all this file is for.
    """
    from app.main import app

    schema = {**app.openapi(), "info": {"title": "AI Interview API", "version": "snapshot"}}
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
