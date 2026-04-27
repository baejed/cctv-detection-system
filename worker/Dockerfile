FROM python:3.12-slim

# OpenCV runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY worker/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY common/ common/
COPY worker/ worker/
# Pre-download YOLO weights so they aren't fetched at container startup
RUN python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

ENV PYTHONPATH=/app

CMD ["python", "-m", "worker.main"]
