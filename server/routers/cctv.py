import socket
import uuid
import select
import re
from server.schemas import CCTVBase, CCTVCreate, CCTVUpdate, CCTVResponse
from server.utils import log_and_commit, get_current_user
from fastapi import APIRouter, Depends, HTTPException, Request
from common.models import User, CCTV
from common.database import get_db
from server.rate_limit import limiter
from sqlalchemy.orm import Session
from typing import Annotated
from pydantic import BaseModel


router = APIRouter(
    prefix="/cctvs",
    tags=["CCTVs"]
)

# ---------------------------------------------------------------------------
# ONVIF WS-Discovery
# ---------------------------------------------------------------------------

_WS_DISCOVERY_ADDR = ("239.255.255.250", 3702)
_WS_DISCOVERY_TIMEOUT = 3.0

_PROBE_TEMPLATE = """\
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope
  xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
    <a:MessageID>uuid:{msg_id}</a:MessageID>
    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
  </s:Header>
  <s:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </s:Body>
</s:Envelope>"""


class DiscoveredCamera(BaseModel):
    address: str
    rtsp_url: str | None = None
    xaddrs: list[str] = []


def _parse_xaddrs(xml_text: str) -> list[str]:
    """Extract XAddrs from a WS-Discovery ProbeMatch response."""
    matches = re.findall(r'<[^:>]*:?XAddrs[^>]*>(.*?)</[^:>]*:?XAddrs>', xml_text, re.DOTALL)
    addrs: list[str] = []
    for m in matches:
        for addr in m.strip().split():
            addr = addr.strip()
            if addr:
                addrs.append(addr)
    return addrs


def _parse_address(xml_text: str) -> str | None:
    """Extract device address from EndpointReference/Address."""
    m = re.search(r'<[^:>]*:?Address[^>]*>(.*?)</[^:>]*:?Address>', xml_text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return None


def _discover_onvif_cameras() -> list[DiscoveredCamera]:
    """
    Send a WS-Discovery Probe over UDP multicast and collect ProbeMatch responses.
    Returns a list of discovered cameras with their XAddrs (HTTP management URLs).
    """
    msg_id = str(uuid.uuid4())
    probe = _PROBE_TEMPLATE.format(msg_id=msg_id).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
    sock.settimeout(_WS_DISCOVERY_TIMEOUT)

    seen: set[str] = set()
    found: list[DiscoveredCamera] = []

    try:
        sock.sendto(probe, _WS_DISCOVERY_ADDR)

        import time
        deadline = time.monotonic() + _WS_DISCOVERY_TIMEOUT
        while time.monotonic() < deadline:
            remaining = deadline -time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([sock], [], [], remaining)
            if not ready:
                break
            try:
                data, (src_ip, _) = sock.recvfrom(65536)
            except socket.timeout:
                break

            if src_ip in seen:
                continue
            seen.add(src_ip)

            text = data.decode("utf-8", errors="replace")
            xaddrs = _parse_xaddrs(text)

            # Build a default RTSP URL guess from the IP
            rtsp_guess = f"rtsp://{src_ip}:554/cam/realmonitor?channel=1&subtype=0"

            found.append(DiscoveredCamera(
                address=src_ip,
                rtsp_url=rtsp_guess,
                xaddrs=xaddrs,
            ))

    except OSError:
        pass
    finally:
        sock.close()

    return found


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

@router.post("/", response_model=CCTVResponse)
def create_cctv(
    cctv: CCTVCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CCTVResponse:
    db_cctv = CCTV(name=cctv.name, intersection_id=cctv.intersection_id, rtsp_url=cctv.rtsp_url)
    db.add(db_cctv)
    log_and_commit(f"User {user.username} created cctv {db_cctv.name}", db)
    db.refresh(db_cctv)
    return db_cctv


@router.get("/", response_model=list[CCTVResponse])
def get_cctvs(
    db: Annotated[Session, Depends(get_db)],
) -> list[CCTVResponse]:
    from sqlalchemy import text as _text
    cctvs = db.query(CCTV).all()
    fresh = {
        row[0]
        for row in db.execute(_text(
            "SELECT cctv_id FROM worker_heartbeats "
            "WHERE last_seen > NOW() - INTERVAL '15 seconds'"
        )).fetchall()
    }
    for c in cctvs:
        c.status = "online" if c.id in fresh else "offline"
    return cctvs


@router.get("/discover", response_model=list[DiscoveredCamera])
@limiter.limit("6/minute")
def discover_cameras(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
):
    """
    WS-Discovery scan for ONVIF cameras on the local network.
    Sends a UDP multicast probe and collects responses for 3 seconds.
    """
    return _discover_onvif_cameras()


@router.get("/{cctv_id}", response_model=CCTVResponse)
def get_cctv(
    cctv_id: int,
    db: Annotated[Session, Depends(get_db)],
) -> CCTVResponse:
    from sqlalchemy import text as _text
    cctv = db.get(CCTV, cctv_id)

    if not cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    row = db.execute(_text(
        "SELECT 1 FROM worker_heartbeats "
        "WHERE cctv_id = :id AND last_seen > NOW() - INTERVAL '15 seconds'"
    ), {"id": cctv_id}).fetchone()
    cctv.status = "online" if row else "offline"
    return cctv


@router.put("/{cctv_id}", response_model=CCTVResponse)
def update_cctv(
    cctv_id: int,
    cctv: CCTVUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CCTVResponse:
    db_cctv = db.get(CCTV, cctv_id)

    if not db_cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    old_name = db_cctv.name
    if cctv.name is not None:
        db_cctv.name = cctv.name
    if cctv.rtsp_url is not None:
        db_cctv.rtsp_url = cctv.rtsp_url
    if cctv.intersection_id is not None:
        db_cctv.intersection_id = cctv.intersection_id
    log_and_commit(f"User {user.username} updated cctv {old_name} to {db_cctv.name}", db)
    db.refresh(db_cctv)
    return db_cctv


@router.delete("/{cctv_id}")
def delete_cctv(
    cctv_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    db_cctv = db.get(CCTV, cctv_id)

    if not db_cctv:
        raise HTTPException(status_code=404, detail="CCTV not found")

    db.delete(db_cctv)
    log_and_commit(f"User {user.username} deleted cctv {db_cctv.name}", db)
    return {"detail": "CCTV deleted"}
