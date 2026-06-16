#!/bin/bash
set -e

MODEL="${MODEL_VERSION:-eyegila_v4}"
TRT_CACHE="${TRT_CACHE_DIR:-/app/trt_cache}"
ENGINE="${TRT_CACHE}/${MODEL}.engine"

mkdir -p "$TRT_CACHE"
LOCKFILE="${TRT_CACHE}/export.lock"

(
  flock -x 200
  if [ ! -f "$ENGINE" ]; then
    echo "[entrypoint] TensorRT FP16 engine not found for ${MODEL} — exporting (first run, ~5-15 min)..."
    python - <<PYEOF
import os, shutil
from ultralytics import YOLO

model_ver = os.environ.get("MODEL_VERSION", "eyegila_v4")
cache     = os.environ.get("TRT_CACHE_DIR", "/app/trt_cache")
dst       = os.path.join(cache, f"{model_ver}.engine")
batch     = int(os.environ.get("CAMERAS_PER_WORKER", "16"))

model    = YOLO("/app/model.pt")
exported = model.export(format="engine", half=True, device=0, imgsz=480, dynamic=True, batch=batch)
shutil.move(str(exported), dst)
print(f"[entrypoint] engine saved to {dst}")
PYEOF
    echo "[entrypoint] Export complete."
  else
    echo "[entrypoint] TensorRT engine found at $ENGINE"
  fi
) 200>"$LOCKFILE"

exec python -m worker.main "$@"
