"""Shared bounding-box overlay rendering, used by both the worker (to bake
boxes into the frame before publishing to Redis) and the server (legacy path
that still draws server-side). Keeping both processes on the same drawing
code keeps the visual style consistent regardless of which side renders.
"""
from __future__ import annotations

import cv2
import numpy as np


# Same palette as the legacy server-side renderer (BGR for cv2).
TYPE_COLORS: dict[str, tuple[int, int, int]] = {
    "car":        ( 22, 163,  74),
    "motorcycle": (  3, 105, 161),
    "tricycle":   (217, 119,   6),
    "truck":      (220,  38,  38),
    "pedicab":    (124,  58, 237),
    "pedestrian": (  8, 145, 178),
    "person":     (  8, 145, 178),
}
DEFAULT_COLOR = (100, 100, 100)


def draw_boxes(frame: np.ndarray, detections: list[dict]) -> None:
    """Draw `detections` onto `frame` in place. Coordinates are normalized [0,1]."""
    h, w = frame.shape[:2]
    for det in detections:
        x1 = int(det["x1"] * w)
        y1 = int(det["y1"] * h)
        x2 = int(det["x2"] * w)
        y2 = int(det["y2"] * h)
        color = TYPE_COLORS.get(det.get("object_type", ""), DEFAULT_COLOR)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"{det.get('object_type', '?')} {det.get('confidence', 0):.2f}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        ty = max(y1 - 4, th + 2)
        cv2.rectangle(frame, (x1, ty - th - 2), (x1 + tw + 2, ty + 2), color, -1)
        cv2.putText(frame, label, (x1 + 1, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
