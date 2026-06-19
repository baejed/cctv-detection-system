"""Infrastructure intervention label assignment (pure-function precedence rule).

Used for synthetic-data label generation in the multi-task 1D-CNN training
pipeline (`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`).

The model's intervention head is a 3-class softmax over:
    - "signalize"      install a new traffic signal
    - "road_widening"  add capacity (post-Webster's critical v/c is too high)
    - "timing_only"    no structural change; retiming alone suffices

Label assignment uses a deterministic precedence (locked by the PRD):

    1. road_widening  — if critical v/c after Webster's > 0.90 the
                        intersection is over capacity; adding a signal
                        cannot help, so a structural fix is required.
    2. signalize      — if the intersection is unsignalized AND at least one
                        MUTCD or W-Local warrant is met.
    3. timing_only    — fall-through; either already signalized at adequate
                        capacity, or no warrant fires.

This module is DB-free, framework-free, and fully unit-testable. It does not
run Webster's itself — callers pass in `critical_vc` already computed.
"""
from __future__ import annotations

from typing import Mapping


INTERVENTION_CLASSES: tuple[str, ...] = ("signalize", "road_widening", "timing_only")

DEFAULT_WIDENING_VC_THRESHOLD = 0.90


def _any_warrant_met(warrant_results: Mapping[str, tuple[bool, float]]) -> bool:
    """Return True if any (met, confidence) pair in `warrant_results` is met."""
    return any(bool(value[0]) for value in warrant_results.values())


def assign_intervention_label(
    critical_vc: float,
    is_signalized: bool,
    warrant_results: Mapping[str, tuple[bool, float]],
    widening_vc_threshold: float = DEFAULT_WIDENING_VC_THRESHOLD,
) -> str:
    """Return the intervention label for one (intersection × day) sample.

    Parameters
    ----------
    critical_vc:
        Critical volume-to-capacity ratio from Webster's run against the
        day's K-means-derived TOD chunks. Values > 1.0 are allowed; values
        strictly greater than `widening_vc_threshold` trigger road_widening.
    is_signalized:
        Whether the intersection already has a traffic signal.
    warrant_results:
        Mapping of warrant name → (met, confidence). Confidence is unused
        here; only the boolean `met` flag participates in the precedence.
    widening_vc_threshold:
        v/c cutoff above which a structural fix is required. Defaults to
        the PRD-specified 0.90.

    Returns
    -------
    One of `INTERVENTION_CLASSES`.
    """
    if critical_vc > widening_vc_threshold:
        return "road_widening"
    if (not is_signalized) and _any_warrant_met(warrant_results):
        return "signalize"
    return "timing_only"
