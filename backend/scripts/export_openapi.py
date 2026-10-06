"""Write the app's OpenAPI schema to frontend/src/api/openapi.json (see app/openapi_snapshot.py).

Run after changing a route or a request/response model, then regenerate the frontend types:

    cd backend && python scripts/export_openapi.py
    cd ../frontend && npm run gen:api
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Importing the app needs these; the schema does not depend on their values.
os.environ.setdefault("SECRET_KEY", "openapi-export")
os.environ.setdefault("ENCRYPTION_KEY", "b3BlbmFwaS1leHBvcnQtb3BlbmFwaS1leHBvcnQtMDA=")

from app.openapi_snapshot import SNAPSHOT_PATH, render  # noqa: E402

SNAPSHOT_PATH.write_text(render(), encoding="utf-8")
print(f"wrote {SNAPSHOT_PATH}")
