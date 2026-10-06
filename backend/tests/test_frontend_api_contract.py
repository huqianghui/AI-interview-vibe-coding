"""The frontend's API calls and the backend's routes must agree, in both directions.

Frontend → backend: every path the SPA's API layer calls must exist here. A route renamed or
deleted on one side only fails at runtime as a 404/405 in the browser, and no unit test on either
side can see it — each side's tests mock the other.

Backend → frontend: every route the SPA does NOT call must be listed in ``NOT_CALLED_BY_THE_SPA``
with who does call it. That list is how dead endpoints get noticed: a route nobody calls has to be
written down here, next to an honest reason, or this test fails.

The frontend paths are read straight from ``frontend/src`` (same repo, so CI always has them).
"""

import re
from pathlib import Path

import pytest

from app.main import app

FRONTEND_SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"

# Files that build API URLs. The voice WS is built in a hook, not the API layer.
API_FILES = [
    *sorted((FRONTEND_SRC / "api").glob("*.ts")),
    FRONTEND_SRC / "hooks" / "useInterviewVoice.ts",
]

# Routes the SPA never calls, and who does. Keep each reason specific enough to check.
NOT_CALLED_BY_THE_SPA: dict[str, str] = {
    "/health": "container-app probes, nginx, the deploy workflow's smoke check",
    "/candidate/interview/{}/end": "e2e helper candidateLogin.ts finalizes external interviews",
    "/admin/question-banks/import": "scripts/sync_bank_to_server.py",
    "/admin/question-banks/{}/export": "manual bank export for the client hand-off bundle",
    "/admin/sop/documents": "scripts/sync_bank_to_server.py uploads SOP sources",
}

WS_ROUTES = {"/voice-live/ws"}  # not in OpenAPI


def _normalize(path: str) -> str:
    """``/a/${x}/b?q=1`` and ``/a/{x_id}/b`` both become ``/a/{}/b``.

    An interpolation that fills a whole segment is a path parameter; one glued onto a segment only
    appends a query string (``/models${refresh ? "?refresh=true" : ""}``), so it is dropped — and
    that has to happen before the query split, because its own ``?`` would cut the path short.
    """
    path = re.sub(r"(?<=/)\$\{[^}]*\}", "{}", path)
    path = re.sub(r"\$\{[^}]*\}", "", path)
    path = path.split("?", 1)[0]
    path = re.sub(r"\{[^}]*\}", "{}", path)
    return path.rstrip("/") or "/"


_CALL_PATTERNS = (
    # request<T>("/x") / adminRequest<T>(`/x/${id}`) — first argument starting with "/".
    r"(?:adminRequest|request)<[^>]*>\(\s*\"(/[^\"]*)\"",
    r"(?:adminRequest|request)<[^>]*>\(\s*`(/[^`]*)`",
    # fetch(`${BASE}/x`, {...})
    r"`\$\{BASE\}(/[^`]*)`",
)


def _rest_of_call(src: str, start: int) -> str:
    """The text from ``start`` (just past the URL literal) to the call's closing parenthesis."""
    depth = 1
    for i in range(start, len(src)):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[start:i]
    return src[start:]


def _frontend_calls() -> dict[tuple[str, str], set[str]]:
    """``(METHOD, normalized path)`` → the frontend files that make that call."""
    found: dict[tuple[str, str], set[str]] = {}
    for file in API_FILES:
        src = file.read_text(encoding="utf-8")
        for pattern in _CALL_PATTERNS:
            for m in re.finditer(pattern, src):
                method = re.search(r"method:\s*\"([A-Z]+)\"", _rest_of_call(src, m.end()))
                key = (method.group(1) if method else "GET", _normalize(m.group(1)))
                found.setdefault(key, set()).add(file.name)
        if re.search(r"/voice-live/ws\b", src):
            found.setdefault(("WS", "/voice-live/ws"), set()).add(file.name)
    return found


def _frontend_paths() -> set[str]:
    return {path for _method, path in _frontend_calls()}


def _backend_routes() -> dict[str, set[str]]:
    """Normalized path → the HTTP methods served there (WS routes are not in OpenAPI)."""
    routes: dict[str, set[str]] = {path: {"WS"} for path in WS_ROUTES}
    for path, ops in app.openapi()["paths"].items():
        routes.setdefault(_normalize(path), set()).update(op.upper() for op in ops)
    return routes


def _backend_paths() -> set[str]:
    return set(_backend_routes())


def test_the_scanner_actually_finds_the_frontend_calls():
    # Guard the guard: if a refactor changes how URLs are written, the regexes would silently find
    # nothing and both directions below would pass vacuously.
    paths = _frontend_paths()
    assert len(paths) >= 35, sorted(paths)
    calls = _frontend_calls()
    assert ("POST", "/candidate/interview/{}/answer") in calls
    assert ("GET", "/admin/users") in calls  # no method: → GET
    assert "/candidate/interview/{}/answer" in paths
    assert "/admin/config/ai-foundry/voice-live-models" in paths
    assert "/voice-live/ws" in paths


def test_every_frontend_call_has_a_backend_route():
    backend = _backend_routes()
    missing = {
        f"{method} {path}": sorted(files)
        for (method, path), files in _frontend_calls().items()
        if path not in backend
    }
    assert not missing, f"frontend calls routes the backend does not serve (404): {missing}"


def test_every_frontend_call_uses_a_method_the_route_accepts():
    backend = _backend_routes()
    wrong = {
        f"{method} {path}": sorted(backend[path])
        for (method, path), _files in _frontend_calls().items()
        if path in backend and method not in backend[path]
    }
    assert not wrong, f"frontend calls with a method the route does not accept (405): {wrong}"


def test_every_route_the_spa_does_not_call_is_accounted_for():
    uncalled = _backend_paths() - _frontend_paths()
    unexplained = sorted(uncalled - set(NOT_CALLED_BY_THE_SPA))
    assert not unexplained, (
        f"routes with no SPA caller and no entry in NOT_CALLED_BY_THE_SPA: {unexplained} — "
        "add who calls them, or delete them"
    )


@pytest.mark.parametrize("path", sorted(NOT_CALLED_BY_THE_SPA))
def test_the_allowlist_has_no_stale_entries(path):
    # An entry for a route that is gone, or that the SPA now calls, is itself rot.
    assert path in _backend_paths(), f"{path} is listed but no longer exists"
    assert path not in _frontend_paths(), f"{path} is listed but the SPA calls it now"
