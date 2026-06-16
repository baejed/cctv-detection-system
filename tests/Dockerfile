# syntax=docker/dockerfile:1
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first so pip cache layer is reused on code changes
COPY server/requirements.txt ./server/requirements.txt
COPY requirements-test.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements-test.txt

COPY common ./common
COPY server ./server
COPY worker ./worker
COPY tests ./tests

ENV PYTHONPATH=/app

ENTRYPOINT ["pytest"]
CMD ["tests/", "-v", "--tb=short", "-m", "not ratelimit", "--no-header"]
