#!/usr/bin/env bash
# stream_chaos.sh — simulate CCTV stream failures against mediamtx
#
# Usage:
#   ./scripts/stream_chaos.sh                    # default: cam1, 1 cycle
#   ./scripts/stream_chaos.sh cam2               # different path
#   ./scripts/stream_chaos.sh cam1 3             # 3 failure cycles
#
# What it does:
#   1. Pushes a colour-bar test pattern to mediamtx (simulates a live CCTV)
#   2. Runs for UP_SEC seconds  → you should see "● live" in the browser
#   3. Kills the stream          → you should see "✕ no stream" + Reconnect button
#   4. Waits DOWN_SEC seconds   → confirms the reconnect button / auto-retry works
#   5. Restarts the stream       → you should see "● live" again automatically
#   Repeats for CYCLES iterations.
#
# What to watch for:
#   - mediamtx logs: should see exactly 1 reader session (not 20+) even with
#     multiple browser tabs open
#   - Browser: "● live" → "✕ no stream" → "● live" after reconnect
#   - Server logs: "[camera_ws] cctv=N capture thread started" on reconnect

RTSP_HOST="${MEDIAMTX_HOST:-localhost}"
RTSP_PORT="${RTSP_PORT:-8554}"
PATH_NAME="${1:-cam1}"
CYCLES="${2:-1}"

UP_SEC=15      # how long the stream stays "up" per cycle
DOWN_SEC=10    # how long the stream stays "down" per cycle

RTSP_URL="rtsp://${RTSP_HOST}:${RTSP_PORT}/${PATH_NAME}"

FFMPEG_PID=""

cleanup() {
  if [ -n "$FFMPEG_PID" ] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill "$FFMPEG_PID" 2>/dev/null
  fi
  echo ""
  echo "[chaos] cleaned up"
  exit 0
}
trap cleanup INT TERM

start_stream() {
  echo "[chaos] ▶  stream UP → ${RTSP_URL}"
  # colour bars + 1 kHz tone; re-encodes at 15 FPS so it's light on CPU
  ffmpeg -hide_banner -loglevel warning \
    -re \
    -f lavfi -i "testsrc2=size=854x480:rate=15" \
    -f lavfi -i "sine=frequency=1000:sample_rate=8000" \
    -c:v libx264 -preset ultrafast -tune zerolatency \
    -c:a aac -b:a 32k \
    -f rtsp -rtsp_transport tcp \
    "${RTSP_URL}" &
  FFMPEG_PID=$!
}

stop_stream() {
  if [ -n "$FFMPEG_PID" ] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill "$FFMPEG_PID" 2>/dev/null
    wait "$FFMPEG_PID" 2>/dev/null
    FFMPEG_PID=""
    echo "[chaos] ■  stream DOWN"
  fi
}

echo "[chaos] target: ${RTSP_URL}"
echo "[chaos] cycles: ${CYCLES}  (up=${UP_SEC}s  down=${DOWN_SEC}s)"
echo "[chaos] open the camera page in your browser now, then watch the status badge"
echo ""

for i in $(seq 1 "$CYCLES"); do
  echo "[chaos] ── cycle ${i}/${CYCLES} ───────────────────────────────"

  start_stream
  echo "[chaos] waiting ${UP_SEC}s — browser should show '● live'"
  sleep "$UP_SEC"

  stop_stream
  echo "[chaos] waiting ${DOWN_SEC}s — browser should show '✕ no stream'"
  echo "[chaos] click Reconnect or wait for the 3 s auto-retry"
  sleep "$DOWN_SEC"
done

# leave the stream up at the end
echo "[chaos] ── final: leaving stream UP ─────────────────────────"
start_stream
echo "[chaos] stream running (PID ${FFMPEG_PID}). Press Ctrl-C to stop."
wait "$FFMPEG_PID"
