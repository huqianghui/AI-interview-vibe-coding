"""The frontend's committed OpenAPI snapshot matches the running app (app/openapi_snapshot.py)."""

import json

from app.openapi_snapshot import SNAPSHOT_PATH, render

REGENERATE = (
    "cd backend && python scripts/export_openapi.py && cd ../frontend && npm run gen:api, "
    "then fix whatever frontend/src/api/contract.check.ts reports"
)


def test_the_committed_snapshot_is_the_current_schema():
    assert SNAPSHOT_PATH.read_text(encoding="utf-8") == render(), (
        f"the API changed but its snapshot did not: {REGENERATE}"
    )


def test_every_schema_has_its_own_name():
    # Two models with one class name come out as app__api__module__Name, which the frontend contract
    # then has to spell; give each a distinct name instead.
    schemas = json.loads(render())["components"]["schemas"]
    assert not [name for name in schemas if name.startswith("app__")]
