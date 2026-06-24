#!/usr/bin/env bash
# Re-seed the 8 RTSP single-output intersections, rewriting every rtsp_url to
# the current Wi-Fi LAN IP. Run this every time the laptop changes network
# (cafe -> office -> home) so MediaMTX / OBS / the worker keep pointing at
# the right host.
#
# Usage:
#   scripts/reseed-rtsp.sh                  # auto-detect Wi-Fi IP (Mac en0/en1)
#   scripts/reseed-rtsp.sh 192.168.1.42     # override explicitly
#   RTSP_PORT=8554 scripts/reseed-rtsp.sh   # add a port to the URLs
#
# Requires: docker (timescaledb + server containers running).

set -euo pipefail

# ── 1. Resolve the host's LAN IP ─────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  HOST_IP="$1"
  echo "Using explicit IP: $HOST_IP"
else
  # Prefer ipconfig (macOS): query the interface the default route uses.
  # Falls back to en0 then en1, since those cover Wi-Fi on most Macs.
  if command -v ipconfig >/dev/null 2>&1; then
    DEFAULT_IFACE="$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')"
    for iface in "$DEFAULT_IFACE" en0 en1; do
      [[ -z "$iface" ]] && continue
      HOST_IP="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [[ -n "$HOST_IP" ]] && { echo "Detected $iface → $HOST_IP"; break; }
    done
  fi

  # Linux / fallback path.
  if [[ -z "${HOST_IP:-}" ]] && command -v ip >/dev/null 2>&1; then
    HOST_IP="$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
    [[ -n "$HOST_IP" ]] && echo "Detected via ip route → $HOST_IP"
  fi

  if [[ -z "${HOST_IP:-}" ]]; then
    echo "ERROR: could not auto-detect LAN IP. Pass it as an argument:" >&2
    echo "  $0 192.168.1.42" >&2
    exit 1
  fi
fi

# Refuse the Docker bridge range that the Python socket trick picks up.
if [[ "$HOST_IP" == 10.49.* || "$HOST_IP" == 172.17.* || "$HOST_IP" == 172.18.* ]]; then
  echo "WARNING: $HOST_IP looks like a Docker bridge, not your Wi-Fi IP." >&2
  echo "         Pass the correct IP explicitly: $0 <ip>" >&2
  exit 1
fi

# ── 2. Copy the latest seeder into the server container ─────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker cp "$SCRIPT_DIR/fake_detections.py" server:/app/fake_detections.py

# ── 3. Run the seeder with the resolved IP ──────────────────────────────────
if [[ -n "${RTSP_PORT:-}" ]]; then
  docker exec -e "RTSP_HOST=$HOST_IP" -e "RTSP_PORT=$RTSP_PORT" server \
    python /app/fake_detections.py --rtsp
else
  docker exec -e "RTSP_HOST=$HOST_IP" server \
    python /app/fake_detections.py --rtsp
fi

# ── 4. Force-refresh the TimescaleDB continuous aggregate so the
#       just-inserted detections show up immediately in warrant evaluation.
# ────────────────────────────────────────────────────────────────────────────
docker exec timescaledb psql -U postgres -d traffic \
  -c "CALL refresh_continuous_aggregate('aggregation_summaries', NULL, NULL);"

echo ""
echo "Done. RTSP URLs now point at: rtsp://${HOST_IP}${RTSP_PORT:+:$RTSP_PORT}/cam{1..4}"
echo "Click 'Run all analyses' on the dashboard to regenerate warrants."
