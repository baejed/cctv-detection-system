"""Unit tests for worker/stream.py URL resolution.

Regression: cameras configured with rtmp://... URLs were silently rewritten
to malformed rtsp://...:port/cam/realmonitor... strings because the resolver
only recognised rtsp:// and rtsps:// as "full URLs" and treated everything
else as a bare Dahua hostname. The worker then logged repeated FFmpeg
"Port missing in uri" / "Connection refused" errors against a phantom RTSP
host that didn't exist.
"""
import argparse
from types import SimpleNamespace

from worker.stream import resolve_rtsp_url


def _args(debug: bool = False) -> argparse.Namespace:
    # Mirror the real argparse Namespace shape the worker passes in.
    return SimpleNamespace(
        debug=debug,
        username="admin",
        password="admin",
        port=554,
        channel=1,
        subtype=False,
    )


def _cam(url: str) -> SimpleNamespace:
    return SimpleNamespace(rtsp_url=url)


# ── Passthrough: full URLs of any supported scheme are returned untouched ────

def test_resolves_rtsp_url_passthrough():
    out = resolve_rtsp_url(_cam("rtsp://mediamtx:8554/cam1"), _args())
    assert out == "rtsp://mediamtx:8554/cam1"


def test_resolves_rtsps_url_passthrough():
    out = resolve_rtsp_url(_cam("rtsps://example.com:322/cam1"), _args())
    assert out == "rtsps://example.com:322/cam1"


def test_resolves_rtmp_url_passthrough():
    """Regression: rtmp:// URLs must NOT be rewritten as Dahua paths."""
    out = resolve_rtsp_url(_cam("rtmp://192.168.254.103:1935/cam1"), _args())
    assert out == "rtmp://192.168.254.103:1935/cam1"


def test_resolves_rtmps_url_passthrough():
    out = resolve_rtsp_url(_cam("rtmps://media.example.com/cam1"), _args())
    assert out == "rtmps://media.example.com/cam1"


def test_resolves_http_url_passthrough():
    """FFmpeg can open HLS / progressive HTTP - pass them through too."""
    out = resolve_rtsp_url(_cam("http://server.local/cam1.m3u8"), _args())
    assert out == "http://server.local/cam1.m3u8"


def test_resolves_https_url_passthrough():
    out = resolve_rtsp_url(_cam("https://server.local/cam1.m3u8"), _args())
    assert out == "https://server.local/cam1.m3u8"


def test_passthrough_is_case_insensitive():
    """Some controllers store URLs uppercased - the scheme check must not care."""
    out = resolve_rtsp_url(_cam("RTMP://192.168.254.103:1935/cam1"), _args())
    assert out == "RTMP://192.168.254.103:1935/cam1"


# ── Dahua-style fallback only kicks in for bare host/IP ──────────────────────

def test_resolves_bare_ip_to_dahua_rtsp():
    out = resolve_rtsp_url(_cam("10.0.0.42"), _args())
    assert out is not None
    assert out.startswith("rtsp://admin:admin@10.0.0.42:554/")
    assert "channel=1" in out
    assert "subtype=0" in out


def test_resolves_bare_hostname_to_dahua_rtsp():
    out = resolve_rtsp_url(_cam("camera.lan"), _args())
    assert out is not None
    assert out.startswith("rtsp://admin:admin@camera.lan:554/")


# ── Debug mode returns None (worker uses webcam) ─────────────────────────────

def test_debug_mode_returns_none():
    out = resolve_rtsp_url(_cam("rtmp://192.168.254.103:1935/cam1"), _args(debug=True))
    assert out is None
