"""
Standalone ONVIF / WS-Discovery probe — runs on the host (no docker).

Sends a WS-Discovery Probe to the ONVIF multicast group and listens for
ProbeMatch responses. Optionally also probes a specific IP unicast (useful
when you know the camera's IP but multicast isn't reaching it — e.g. across
a wired bridge, or when the camera doesn't honor multicast).

Usage
-----
# Multicast discovery on the default interface, 3s timeout
python3 scripts/onvif_discover.py

# Longer timeout (some cameras take 5+ seconds to reply)
python3 scripts/onvif_discover.py --timeout 10

# Bind multicast to a specific interface IP (use one from `ifconfig`)
python3 scripts/onvif_discover.py --interface 192.168.1.5

# Add a unicast probe to a known camera IP (in addition to multicast)
python3 scripts/onvif_discover.py --probe 192.168.1.42

# Skip multicast entirely; only do unicast probes
python3 scripts/onvif_discover.py --no-multicast --probe 192.168.1.42 --probe 192.168.1.43
"""
from __future__ import annotations

import argparse
import re
import select
import socket
import sys
import time
import uuid

WS_DISCOVERY_ADDR = ("239.255.255.250", 3702)

PROBE_TEMPLATE = """\
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


def parse_xaddrs(xml_text: str) -> list[str]:
    matches = re.findall(r"<[^:>]*:?XAddrs[^>]*>(.*?)</[^:>]*:?XAddrs>", xml_text, re.DOTALL)
    out: list[str] = []
    for m in matches:
        for addr in m.strip().split():
            addr = addr.strip()
            if addr:
                out.append(addr)
    return out


def parse_scopes(xml_text: str) -> list[str]:
    m = re.search(r"<[^:>]*:?Scopes[^>]*>(.*?)</[^:>]*:?Scopes>", xml_text, re.DOTALL)
    if not m:
        return []
    return [s for s in m.group(1).strip().split() if s]


def discover(interface: str | None, timeout: float, unicast_targets: list[str], multicast: bool) -> dict[str, dict]:
    msg_id = str(uuid.uuid4())
    probe = PROBE_TEMPLATE.format(msg_id=msg_id).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)

    if interface:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
        sock.bind((interface, 0))

    sock.settimeout(timeout)

    if multicast:
        try:
            sock.sendto(probe, WS_DISCOVERY_ADDR)
            print(f"→ multicast probe sent to {WS_DISCOVERY_ADDR[0]}:{WS_DISCOVERY_ADDR[1]}", file=sys.stderr)
        except OSError as e:
            print(f"⚠  multicast send failed: {e}", file=sys.stderr)
            print("   (your current network may not route multicast — try --interface <lan-ip> or use --probe <camera-ip>)", file=sys.stderr)

    for ip in unicast_targets:
        try:
            sock.sendto(probe, (ip, 3702))
            print(f"→ unicast probe sent to {ip}:3702", file=sys.stderr)
        except OSError as e:
            print(f"⚠  unicast probe to {ip} failed: {e}", file=sys.stderr)

    seen: dict[str, dict] = {}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select([sock], [], [], remaining)
        if not ready:
            break
        try:
            data, (src_ip, _) = sock.recvfrom(65536)
        except socket.timeout:
            break

        text = data.decode("utf-8", errors="replace")
        info = seen.setdefault(src_ip, {"xaddrs": [], "scopes": []})
        for x in parse_xaddrs(text):
            if x not in info["xaddrs"]:
                info["xaddrs"].append(x)
        for s in parse_scopes(text):
            if s not in info["scopes"]:
                info["scopes"].append(s)

    sock.close()
    return seen


def main() -> int:
    p = argparse.ArgumentParser(description="ONVIF WS-Discovery probe (standalone)")
    p.add_argument("--timeout", type=float, default=5.0, help="Listen window in seconds (default 5)")
    p.add_argument("--interface", help="Bind to this local interface IP (e.g. 192.168.1.5)")
    p.add_argument("--probe", action="append", default=[], help="Unicast probe to this IP (can repeat)")
    p.add_argument("--no-multicast", dest="multicast", action="store_false", help="Skip the multicast probe")
    args = p.parse_args()

    print(f"Listening for {args.timeout:.0f}s on interface={args.interface or 'default'}", file=sys.stderr)
    cameras = discover(args.interface, args.timeout, args.probe, args.multicast)

    if not cameras:
        print("\nNo cameras responded.", file=sys.stderr)
        print("Things to check:", file=sys.stderr)
        print("  1. Are you on the same Wi-Fi/LAN as the cameras?", file=sys.stderr)
        print("  2. Does the camera have ONVIF discovery enabled? (usually on by default)", file=sys.stderr)
        print("  3. Is UDP 3702 open at the camera and any router/firewall in between?", file=sys.stderr)
        print("  4. Try --interface <your-lan-ip> if you have multiple network interfaces.", file=sys.stderr)
        print("  5. Try --probe <camera-ip> for a unicast probe if you already know an IP.", file=sys.stderr)
        return 1

    print(f"\nFound {len(cameras)} camera(s):\n")
    for ip in sorted(cameras):
        info = cameras[ip]
        print(f"  {ip}")
        for x in info["xaddrs"]:
            print(f"    XAddr:  {x}")
        for s in info["scopes"]:
            print(f"    Scope:  {s}")
        # Try a couple of vendor RTSP guesses to test in VLC / ffprobe
        print(f"    Try in VLC:")
        print(f"      rtsp://admin:<password>@{ip}:554/cam/realmonitor?channel=1&subtype=0   (Dahua)")
        print(f"      rtsp://admin:<password>@{ip}:554/Streaming/Channels/101                (Hikvision)")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
