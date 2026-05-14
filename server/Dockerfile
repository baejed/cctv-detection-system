# syntax=docker/dockerfile:1
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libxcb1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt && \
    python -c "import torch" && \
    python -c "import sklearn"
COPY common ./common
COPY server ./server
COPY worker ./worker
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
