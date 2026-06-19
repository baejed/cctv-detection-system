"""Improvement: a single home for "did the proposed timing beat the current?".

Before this module, the rule lived in three places (two TS pages and one
server router). The threshold (≥0.5 s/veh per-chunk delay saving) and the
"any chunk improves" aggregation are both expressed here so every caller
reads from the same source.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol


# Minimum per-chunk delay saving (s/veh) to count as a real improvement.
# Tuned to ignore floating-point noise around 0; raise the bar if the model
# starts emitting plans that "improve" by under a second.
IMPROVEMENT_THRESHOLD_S = 0.5


class _ChunkSimLike(Protocol):
    """Structural type for a simulated chunk - matches both ORM rows and
    SimulationResponse chunks. Only the two delay fields are required."""
    chunk_name: str
    delay_before: float | None
    delay_after:  float | None


@dataclass(frozen=True)
class Improvement:
    """Aggregate result of evaluating a list of simulated chunks."""

    delay_saved_max:    float    # max (before-after) across non-overall chunks
    chunks_with_saving: int      # how many chunks improved by ≥ threshold
    meets_threshold:    bool     # at least one chunk meets the threshold


def _chunk_saving(s: _ChunkSimLike) -> float:
    return (s.delay_before or 0) - (s.delay_after or 0)


def evaluate(chunk_sims: Iterable[_ChunkSimLike]) -> Improvement:
    """Decide whether a set of simulated chunks counts as an improvement.

    Excludes the synthesised 'overall' chunk so re-timing is judged on the
    underlying TOD periods, not the aggregate.
    """
    real = [s for s in chunk_sims if s.chunk_name != "overall"]
    savings = [_chunk_saving(s) for s in real]
    if not savings:
        return Improvement(delay_saved_max=0.0, chunks_with_saving=0, meets_threshold=False)
    max_saving = max(savings)
    count_above = sum(1 for v in savings if v > IMPROVEMENT_THRESHOLD_S)
    return Improvement(
        delay_saved_max=max_saving,
        chunks_with_saving=count_above,
        meets_threshold=count_above > 0,
    )
