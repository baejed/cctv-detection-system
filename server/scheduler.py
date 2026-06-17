"""Background analysis scheduler.

Runs warrant analysis + timing + simulation for every intersection on a
configurable interval. Wired into the FastAPI lifespan so it starts with
the server and stops cleanly on shutdown.

Configured via ANALYSIS_INTERVAL_MINUTES env var (default: 60).
Set to 0 to disable (useful in dev when using manual Regenerate only).
"""
from __future__ import annotations

import asyncio
import logging
import os

log = logging.getLogger("scheduler")

_INTERVAL_MINUTES = int(os.getenv("ANALYSIS_INTERVAL_MINUTES", "60"))


async def analysis_loop(app) -> None:
    """Async loop: sleep, then run generate-all, repeat."""
    if _INTERVAL_MINUTES <= 0:
        log.info("scheduler: ANALYSIS_INTERVAL_MINUTES=0 - automatic analysis disabled")
        return

    log.info("scheduler: will run analysis every %d minutes", _INTERVAL_MINUTES)

    # Wait one interval before the first run so the server is fully warm
    # and cameras have had time to send initial data.
    await asyncio.sleep(_INTERVAL_MINUTES * 60)

    while True:
        log.info("scheduler: starting automatic generate-all")
        try:
            from common.database import SessionLocal
            from server.routers.recommendations import run_generate_all

            with SessionLocal() as db:
                results = run_generate_all(db, app.state.warrant_artifacts)
            log.info("scheduler: generate-all complete - %d intersections updated", len(results))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("scheduler: generate-all failed - will retry next interval")

        await asyncio.sleep(_INTERVAL_MINUTES * 60)
