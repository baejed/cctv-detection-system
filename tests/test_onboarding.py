"""Onboarding wizard progress tests (Issue #1).

Integration tests for GET/PATCH /onboarding/progress, the per-user
server-side wizard step persistence that powers pause/resume.

These run against a live stack and auto-skip when the server is not
reachable (see tests/conftest.py).
"""
from tests.conftest import API_URL


def test_progress_requires_auth(api):
    """The endpoint must reject unauthenticated callers."""
    r = api.get(f"{API_URL}/onboarding/progress")
    assert r.status_code in (401, 403)


def test_progress_roundtrip(auth):
    """A PATCHed step is returned by the subsequent GET (per-user persistence)."""
    r = auth.patch(f"{API_URL}/onboarding/progress", json={"step": "discover"})
    assert r.status_code == 200, r.text
    assert r.json()["step"] == "discover"

    r = auth.get(f"{API_URL}/onboarding/progress")
    assert r.status_code == 200, r.text
    assert r.json()["step"] == "discover"


def test_progress_resume_advances(auth):
    """Updating to a later step overwrites the stored step (resume point)."""
    auth.patch(f"{API_URL}/onboarding/progress", json={"step": "regions"})
    r = auth.get(f"{API_URL}/onboarding/progress")
    assert r.json()["step"] == "regions"


def test_progress_can_be_cleared(auth):
    """Sending a null step clears the saved progress (e.g. on finish)."""
    auth.patch(f"{API_URL}/onboarding/progress", json={"step": "timing"})
    r = auth.patch(f"{API_URL}/onboarding/progress", json={"step": None})
    assert r.status_code == 200, r.text
    assert r.json()["step"] is None

    r = auth.get(f"{API_URL}/onboarding/progress")
    assert r.json()["step"] is None
