"""Auth endpoint tests — login, logout, token enforcement, rate limiting."""
import os
import time
import pytest
import requests
from tests.conftest import API_URL, ADMIN_USER, ADMIN_PASS


def test_login_success():
    r = requests.post(f"{API_URL}/login",
                      json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert r.status_code == 200
    assert "token" in r.json()


def test_login_wrong_password():
    r = requests.post(f"{API_URL}/login",
                      json={"username": ADMIN_USER, "password": "wrongpassword"})
    assert r.status_code == 401


def test_login_unknown_user():
    r = requests.post(f"{API_URL}/login",
                      json={"username": "nobody", "password": "x"})
    assert r.status_code == 401


def test_protected_endpoint_requires_token():
    r = requests.get(f"{API_URL}/intersections/")
    assert r.status_code in (401, 403)


def test_protected_endpoint_with_valid_token(token):
    r = requests.get(f"{API_URL}/intersections/",
                     headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_invalid_token_rejected():
    r = requests.get(f"{API_URL}/intersections/",
                     headers={"Authorization": "Bearer notarealtoken"})
    assert r.status_code in (401, 403)


def test_logout(token):
    # Get a fresh token so we don't blow up the session fixture
    r = requests.post(f"{API_URL}/login",
                      json={"username": ADMIN_USER, "password": ADMIN_PASS})
    fresh_token = r.json()["token"]

    # Logout
    r = requests.delete(f"{API_URL}/login",
                        headers={"Authorization": f"Bearer {fresh_token}"})
    assert r.status_code == 200

    # The evicted token must no longer work
    r = requests.get(f"{API_URL}/intersections/",
                     headers={"Authorization": f"Bearer {fresh_token}"})
    assert r.status_code in (401, 403)


@pytest.mark.ratelimit
def test_login_rate_limit():
    """11 rapid login attempts from the same IP should trigger 429 on the 11th.

    Excluded from normal runs (exhausts the shared rate limit bucket, breaking
    subsequent tests). Run explicitly: pytest -m ratelimit
    """
    hits_429 = False
    for _ in range(12):
        r = requests.post(f"{API_URL}/login",
                          json={"username": "ratelimitcheck", "password": "x"})
        if r.status_code == 429:
            hits_429 = True
            break
    assert hits_429, "Rate limit (10/minute) was not enforced"
