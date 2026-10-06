"""Every ``/admin/*`` route refuses an anonymous caller (401) and a candidate login (403).

Admin routes are guarded at the router level (``dependencies=[Depends(require_role("admin"))]``),
which is easy to forget on a new router and invisible in a route's own body. This walks the live
route table instead of trusting each module, so a new admin router without the role dependency
fails here on its first commit.
"""

import re

import pytest

from app.main import app


def _admin_operations() -> list[tuple[str, str]]:
    ops = []
    for path, methods in app.openapi()["paths"].items():
        if not path.startswith("/admin"):
            continue
        concrete = re.sub(r"\{[^}]*\}", "x", path)
        ops.extend((method.upper(), concrete) for method in methods)
    return sorted(ops)


ADMIN_OPERATIONS = _admin_operations()


def test_the_route_table_has_admin_routes():
    # Guard the guard: an empty list would make every case below pass vacuously.
    assert len(ADMIN_OPERATIONS) >= 30


@pytest.mark.parametrize(("method", "path"), ADMIN_OPERATIONS)
async def test_admin_route_rejects_an_anonymous_caller(client, method, path):
    resp = await client.request(method, path)
    assert resp.status_code == 401, f"{method} {path} answered {resp.status_code} without auth"


@pytest.mark.parametrize(("method", "path"), ADMIN_OPERATIONS)
async def test_admin_route_rejects_a_candidate_login(client, candidate_auth, method, path):
    resp = await client.request(method, path, headers=candidate_auth)
    assert resp.status_code == 403, f"{method} {path} answered {resp.status_code} to a candidate"
