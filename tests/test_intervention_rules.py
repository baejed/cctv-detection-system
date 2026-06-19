"""Unit tests for `server.intervention_rules.assign_intervention_label`.

Pure-function tests — no DB, no FastAPI app. Mirrors the style of
`tests/test_warrant_rules.py` and `tests/test_local_warrants.py`.

The PRD locks the intervention precedence as:
    1. road_widening  if critical_vc > widening_vc_threshold
    2. signalize      if (not is_signalized) and any warrant met
    3. timing_only    otherwise

This file covers each of the three outcomes plus pairwise-tie scenarios that
exercise the precedence ordering, plus the boundary at vc == threshold.
"""
from __future__ import annotations

import pytest

from server.intervention_rules import (
    DEFAULT_WIDENING_VC_THRESHOLD,
    INTERVENTION_CLASSES,
    _any_warrant_met,
    assign_intervention_label,
)


# ── Fixtures / builders ──────────────────────────────────────────────────────

def _warrants(**flags: bool) -> dict[str, tuple[bool, float]]:
    """Build a warrant_results mapping. Each kwarg becomes (met, 1.0 if met else 0.0)."""
    return {name: (bool(met), 1.0 if met else 0.0) for name, met in flags.items()}


_NO_WARRANTS = _warrants(w1=False, w2=False, w3=False, w4=False)
_W1_MET = _warrants(w1=True, w2=False, w3=False, w4=False)


# ── Module-level constants ───────────────────────────────────────────────────

def test_intervention_classes_are_the_three_locked_labels():
    assert set(INTERVENTION_CLASSES) == {"signalize", "road_widening", "timing_only"}
    assert len(INTERVENTION_CLASSES) == 3


def test_default_widening_threshold_is_prd_value():
    assert DEFAULT_WIDENING_VC_THRESHOLD == 0.90


# ── Helper: _any_warrant_met ─────────────────────────────────────────────────

def test_any_warrant_met_true_if_any_flag_true():
    assert _any_warrant_met(_warrants(a=False, b=True, c=False)) is True


def test_any_warrant_met_false_if_all_flags_false():
    assert _any_warrant_met(_warrants(a=False, b=False, c=False)) is False


def test_any_warrant_met_false_for_empty_mapping():
    assert _any_warrant_met({}) is False


# ── Outcome 1: road_widening ─────────────────────────────────────────────────

def test_widening_when_vc_above_threshold():
    """vc strictly above 0.90 → road_widening, regardless of other factors."""
    label = assign_intervention_label(
        critical_vc=1.05,
        is_signalized=False,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "road_widening"


def test_widening_when_vc_above_threshold_even_if_already_signalized():
    label = assign_intervention_label(
        critical_vc=1.20,
        is_signalized=True,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "road_widening"


# ── Outcome 2: signalize ─────────────────────────────────────────────────────

def test_signalize_when_unsignalized_and_warrant_met_and_vc_low():
    label = assign_intervention_label(
        critical_vc=0.50,
        is_signalized=False,
        warrant_results=_W1_MET,
    )
    assert label == "signalize"


def test_signalize_for_any_single_warrant_met():
    """Any warrant being met is sufficient — the rule reads `any`, not `w1`."""
    for warrant in ("w1", "w2", "w3", "w4", "w_local_2", "w_local_3"):
        flags = {warrant: True}
        label = assign_intervention_label(
            critical_vc=0.50,
            is_signalized=False,
            warrant_results=_warrants(**flags),
        )
        assert label == "signalize", f"expected signalize when {warrant} met"


# ── Outcome 3: timing_only ───────────────────────────────────────────────────

def test_timing_only_when_no_warrant_met_and_vc_low():
    label = assign_intervention_label(
        critical_vc=0.50,
        is_signalized=False,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "timing_only"


def test_timing_only_when_already_signalized_and_warrant_met():
    """Already-signalized intersections fall through to timing_only even when
    a warrant fires (they cannot be `signalize`d again)."""
    label = assign_intervention_label(
        critical_vc=0.50,
        is_signalized=True,
        warrant_results=_W1_MET,
    )
    assert label == "timing_only"


def test_timing_only_when_empty_warrant_results():
    label = assign_intervention_label(
        critical_vc=0.50,
        is_signalized=False,
        warrant_results={},
    )
    assert label == "timing_only"


# ── Precedence ties ──────────────────────────────────────────────────────────

def test_widening_beats_signalize_when_both_eligible():
    """vc>threshold AND unsignalized AND warrant met → widening wins."""
    label = assign_intervention_label(
        critical_vc=0.95,
        is_signalized=False,
        warrant_results=_W1_MET,
    )
    assert label == "road_widening"


def test_widening_beats_timing_only_when_only_widening_eligible():
    label = assign_intervention_label(
        critical_vc=0.95,
        is_signalized=True,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "road_widening"


def test_signalize_beats_timing_only_when_only_signalize_eligible():
    label = assign_intervention_label(
        critical_vc=0.50,
        is_signalized=False,
        warrant_results=_W1_MET,
    )
    assert label == "signalize"


# ── Boundary behaviour at vc == threshold ────────────────────────────────────

def test_vc_exactly_at_threshold_is_not_widening():
    """PRD wording is `v/c > 0.90` (strict). vc == 0.90 must not trigger widening."""
    label = assign_intervention_label(
        critical_vc=0.90,
        is_signalized=True,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "timing_only"


def test_vc_exactly_at_threshold_falls_through_to_signalize_when_eligible():
    label = assign_intervention_label(
        critical_vc=0.90,
        is_signalized=False,
        warrant_results=_W1_MET,
    )
    assert label == "signalize"


def test_vc_just_above_threshold_is_widening():
    label = assign_intervention_label(
        critical_vc=0.9000001,
        is_signalized=True,
        warrant_results=_NO_WARRANTS,
    )
    assert label == "road_widening"


# ── Custom threshold override ────────────────────────────────────────────────

def test_custom_widening_threshold_is_respected():
    """A caller-provided threshold overrides the default."""
    label = assign_intervention_label(
        critical_vc=0.80,
        is_signalized=True,
        warrant_results=_NO_WARRANTS,
        widening_vc_threshold=0.75,
    )
    assert label == "road_widening"


def test_custom_widening_threshold_does_not_trigger_when_vc_below():
    label = assign_intervention_label(
        critical_vc=0.70,
        is_signalized=False,
        warrant_results=_W1_MET,
        widening_vc_threshold=0.75,
    )
    assert label == "signalize"


# ── Return value contract ────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "vc,signalized,warrants",
    [
        (1.10, False, _W1_MET),
        (0.50, False, _W1_MET),
        (0.50, True, _NO_WARRANTS),
        (0.90, False, _NO_WARRANTS),
    ],
)
def test_return_value_is_one_of_the_three_classes(vc, signalized, warrants):
    label = assign_intervention_label(
        critical_vc=vc,
        is_signalized=signalized,
        warrant_results=warrants,
    )
    assert label in INTERVENTION_CLASSES
