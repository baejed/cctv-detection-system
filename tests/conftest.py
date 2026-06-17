"""
Shared fixtures for EyeGila integration tests.

Tests run against a live stack (docker compose up).  The DATABASE_URL /
API_URL can be overridden via environment variables so the same suite works
locally and in CI.

  DATABASE_URL  postgresql://postgres:postgres@localhost:5433/traffic
  API_URL       http://localhost:8000
  ADMIN_USER    admin
  ADMIN_PASS    admin

When the server is not reachable, all tests that depend on the `token`,
`auth`, or `db` fixtures are automatically skipped (not errored).
"""
import os
import pytest
import requests

API_URL    = os.getenv("API_URL",   "http://localhost:8000")
DB_URL     = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/traffic")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin")


_SERVER_UP: bool | None = None


def _server_reachable() -> bool:
    global _SERVER_UP
    if _SERVER_UP is None:
        try:
            requests.get(f"{API_URL}/health", timeout=2)
            _SERVER_UP = True
        except Exception:
            _SERVER_UP = False
    return _SERVER_UP


# Files that contain only integration tests (no pure-unit functions).
# When the server is unreachable, every test in these files is skipped.
_INTEGRATION_ONLY_FILES = {
    "test_auth.py",
    "test_aggregation.py",
    "test_cameras.py",
    "test_camera_ws.py",
    "test_health.py",
    "test_intersections.py",
    "test_tod.py",
    "test_worker_claim.py",
    "test_integration_extended.py",
    "test_pce.py",
    "test_functionality.py",
}


def pytest_collection_modifyitems(items: list) -> None:
    if _server_reachable():
        return
    skip = pytest.mark.skip(reason="API server not reachable - run: docker compose up -d")
    for item in items:
        filename = item.fspath.basename
        if filename in _INTEGRATION_ONLY_FILES:
            item.add_marker(skip)
            continue
        # In mixed files (unit + integration), skip tests that use http fixtures
        if any(f in item.fixturenames for f in ("api", "auth", "db", "token")):
            item.add_marker(skip)


@pytest.fixture(scope="session")
def api():
    """Base requests Session with the API URL pre-set."""
    s = requests.Session()
    s.base_url = API_URL  # type: ignore[attr-defined]
    return s


@pytest.fixture(scope="session")
def token(api):
    """Authenticate once per test session and return the Bearer token.

    Skips all dependent tests when the server is not running.
    """
    if not _server_reachable():
        pytest.skip("API server not reachable - run: docker compose up -d")
    r = api.post(f"{API_URL}/login",
                 json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200, f"Login failed: {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth(token):
    """Requests Session with auth header pre-set."""
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="session")
def db():
    """SQLAlchemy session connected directly to the test DB (port 5433)."""
    if not _server_reachable():
        pytest.skip("API server not reachable - run: docker compose up -d")
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(DB_URL)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    engine.dispose()
