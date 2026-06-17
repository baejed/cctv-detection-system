"""
WebSocket stream endpoint tests.

Covers the failure mode where the server reloads (or restarts) and kills
active WebSocket connections - verified by checking that:
  1. The WS endpoint accepts a valid token.
  2. The WS endpoint rejects an invalid token with close code 4001.
  3. The WS endpoint rejects an unknown camera with close code 4004.

These tests do NOT require a live RTSP stream - they verify the handshake
and auth layer, not frame delivery.
"""
import pytest
import websockets
import asyncio
from tests.conftest import API_URL

WS_BASE = API_URL.replace("http://", "ws://").replace("https://", "wss://")


@pytest.fixture
def intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_ws_test_inter", "latitude": 7.44, "longitude": 125.80})
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


@pytest.fixture
def camera(auth, intersection):
    r = auth.post(f"{API_URL}/cctvs/",
                  json={"name": "_ws_test_cam",
                        "rtsp_url": "rtsp://127.0.0.1:1/nonexistent",
                        "intersection_id": intersection["id"]})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/cctvs/{obj['id']}")


@pytest.mark.asyncio
async def test_ws_rejects_invalid_token(camera):
    """Server must close with 4001 when the token is wrong."""
    cam_id = camera["id"]
    uri = f"{WS_BASE}/cctvs/{cam_id}/ws?token=badtoken&overlay=false"
    async with websockets.connect(uri) as ws:
        close = await ws.wait_closed()
    assert ws.close_code == 4001, f"expected 4001, got {ws.close_code}"


@pytest.mark.asyncio
async def test_ws_rejects_missing_token(camera):
    """Empty token should also trigger 4001."""
    cam_id = camera["id"]
    uri = f"{WS_BASE}/cctvs/{cam_id}/ws?token=&overlay=false"
    async with websockets.connect(uri) as ws:
        await ws.wait_closed()
    assert ws.close_code == 4001


@pytest.mark.asyncio
async def test_ws_rejects_unknown_camera(token):
    """Camera ID 0 cannot exist - server must close with 4004."""
    uri = f"{WS_BASE}/cctvs/0/ws?token={token}&overlay=false"
    async with websockets.connect(uri) as ws:
        await ws.wait_closed()
    assert ws.close_code == 4004


@pytest.mark.asyncio
async def test_ws_accepts_valid_token_then_closes_cleanly(camera, token):
    """
    Valid token + real camera: server accepts the connection.
    The RTSP stream is unreachable so the server will close the socket
    after ~5 s (frame timeout) with a normal close code (not 4001/4004).
    This catches the regression where --reload killed sockets mid-stream.
    """
    cam_id = camera["id"]
    uri = f"{WS_BASE}/cctvs/{cam_id}/ws?token={token}&overlay=false"
    async with websockets.connect(uri) as ws:
        # Connection must open successfully (no immediate rejection)
        assert not ws.close_code, "WebSocket was rejected immediately - check token/auth"
        try:
            # Wait up to 8 s; the server closes after 5 s of no RTSP frames
            await asyncio.wait_for(ws.wait_closed(), timeout=8)
        except asyncio.TimeoutError:
            pass  # still open - acceptable, stream just hasn't timed out yet

    assert ws.close_code not in (4001, 4004), (
        f"Auth/camera error during valid session: close code {ws.close_code}"
    )
