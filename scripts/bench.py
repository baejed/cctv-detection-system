import sys
import time
import numpy as np
from ultralytics import YOLO

def p(msg): print(msg, flush=True)

p("Loading model...")
model = YOLO("eyegila_v4.pt")
p("Model loaded. Warming up...")

dummy = np.zeros((720, 1280, 3), dtype=np.uint8)
model.predict(dummy, verbose=False)
p("Warm-up done. Benchmarking 20 frames at 1280x720...")

times = []
for i in range(20):
    frame = np.random.randint(0, 255, (720, 1280, 3), dtype=np.uint8)
    t = time.perf_counter()
    model.predict(frame, verbose=False)
    elapsed = time.perf_counter() - t
    times.append(elapsed)
    p(f"  frame {i+1:2d}: {elapsed*1000:.1f} ms")

avg = sum(times) / len(times)
p(f"\navg: {avg*1000:.1f} ms  →  max {1/avg:.1f} FPS")
p(f"min: {min(times)*1000:.1f} ms  max: {max(times)*1000:.1f} ms")
