# syntax=docker/dockerfile:1
FROM python:3.11-slim
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install sqlalchemy psycopg2-binary
COPY common ./common
COPY scripts ./scripts
CMD ["sh", "-c", "python scripts/fake_detections.py --full --days 7 && python scripts/fake_detections.py --scenarios"]
