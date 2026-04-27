WORKERS ?= 5

.PHONY: up down reset logs worker-logs ps

# Build images and start the full stack
up:
	docker compose up -d --build --scale worker=$(WORKERS)

# Stop all containers (data is kept)
down:
	docker compose down

# Wipe everything — containers, volumes, images — and start clean
reset:
	docker compose down -v --rmi local
	docker compose up -d --build --scale worker=$(WORKERS)

# Follow logs for all services
logs:
	docker compose logs -f

# Follow logs for workers only
worker-logs:
	docker compose logs -f worker

# Show running containers and their status
ps:
	docker compose ps
