"""Synthetic traffic generator tests (PRD T07).

Pure-function tests - no DB, no FastAPI app. Mirrors the style of
`tests/test_warrant_rules.py` and `tests/test_intervention_rules.py`.

Per `docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`
§Testing Decisions, this file covers three areas:

  * **Determinism** - same seed → identical sample (flow_matrix, metadata,
    warrants, critical_vc, intervention all reproduce bit-for-bit).
  * **Schema completeness** - every sample exposes the full label set
    (5×96 flow_matrix, all 6 warrant names with confidences in [0, 1],
    intervention in the locked 3-class vocabulary, valid IntersectionMeta).
  * **Class-balance sanity** - the intervention class distribution sits
    inside the PRD's documented ranges (~50–65% timing_only, road_widening
    sparse). Acts as the regression guard for any future change to the
    generator's regime / pedestrian / modifier calibration.
"""
from __future__ import annotations

from collections import Counter

import numpy as np
import pytest

from server.intervention_rules import INTERVENTION_CLASSES
from server.ml.synthetic_traffic import (
    N_CHANNELS,
    N_SLOTS,
    N_VEHICLE_CHANNELS,
    PED_CHANNEL_INDEX,
    WARRANT_NAMES_ALL,
    LabeledSample,
    generate_day_flow_matrix,
    generate_labeled_sample,
    sample_intersection_meta,
    sample_intersection_modifier,
)
from server.warrant_rules import IntersectionMeta


# ── Determinism ──────────────────────────────────────────────────────────────

def test_flow_matrix_deterministic_with_same_seed():
    a = generate_day_flow_matrix(np.random.default_rng(0))
    b = generate_day_flow_matrix(np.random.default_rng(0))
    np.testing.assert_array_equal(a, b)


def test_flow_matrix_differs_for_different_seeds():
    a = generate_day_flow_matrix(np.random.default_rng(0))
    b = generate_day_flow_matrix(np.random.default_rng(1))
    assert not np.array_equal(a, b)


def test_labeled_sample_deterministic_with_same_seed():
    a = generate_labeled_sample(np.random.default_rng(0))
    b = generate_labeled_sample(np.random.default_rng(0))
    np.testing.assert_array_equal(a.flow_matrix, b.flow_matrix)
    assert a.meta == b.meta
    assert a.warrants == b.warrants
    assert a.critical_vc == b.critical_vc
    assert a.intervention == b.intervention
    assert a.is_weekend == b.is_weekend


def test_labeled_sample_differs_for_different_seeds():
    a = generate_labeled_sample(np.random.default_rng(0))
    b = generate_labeled_sample(np.random.default_rng(1))
    assert not np.array_equal(a.flow_matrix, b.flow_matrix)


def test_intersection_modifier_deterministic_with_same_seed():
    a = sample_intersection_modifier(np.random.default_rng(7))
    b = sample_intersection_modifier(np.random.default_rng(7))
    np.testing.assert_array_equal(a, b)


def test_intersection_meta_deterministic_with_same_seed():
    a = sample_intersection_meta(np.random.default_rng(7))
    b = sample_intersection_meta(np.random.default_rng(7))
    assert a == b


# ── Schema completeness ──────────────────────────────────────────────────────

def test_n_channels_constants_match_prd_convention():
    # PRD §Implementation Decisions / Algorithmic centerpiece / Inputs:
    # "(5, 96) tensor ... per-slot flow on the four approaches plus
    # pedestrian flow". Pedestrian must be the fifth channel.
    assert N_VEHICLE_CHANNELS == 4
    assert N_CHANNELS == 5
    assert PED_CHANNEL_INDEX == 4
    assert N_SLOTS == 96


def test_flow_matrix_has_shape_5_by_96_and_float64_dtype():
    flow = generate_day_flow_matrix(np.random.default_rng(0))
    assert flow.shape == (N_CHANNELS, N_SLOTS)
    assert flow.dtype == np.float64


def test_flow_matrix_is_nonnegative_everywhere():
    flow = generate_day_flow_matrix(np.random.default_rng(0))
    assert np.all(flow >= 0.0)


def test_labeled_sample_flow_matrix_has_expected_shape():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert s.flow_matrix.shape == (N_CHANNELS, N_SLOTS)


def test_labeled_sample_exposes_all_six_warrant_labels():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert set(s.warrants.keys()) == set(WARRANT_NAMES_ALL)
    assert len(WARRANT_NAMES_ALL) == 6


def test_labeled_sample_warrant_entries_are_met_confidence_pairs():
    s = generate_labeled_sample(np.random.default_rng(0))
    for name, entry in s.warrants.items():
        met, conf = entry
        assert isinstance(met, (bool, np.bool_)), f"{name} met flag is not bool"
        assert 0.0 <= conf <= 1.0, f"{name} confidence out of [0, 1]: {conf}"


def test_labeled_sample_intervention_is_one_of_three_classes():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert s.intervention in INTERVENTION_CLASSES


def test_labeled_sample_critical_vc_is_nonnegative():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert s.critical_vc >= 0.0


def test_labeled_sample_metadata_is_intersection_meta_with_valid_values():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert isinstance(s.meta, IntersectionMeta)
    assert s.meta.major_lanes in {1, 2}
    assert s.meta.minor_lanes in {1, 2}
    assert s.meta.posted_speed_kph in {30, 40, 50}
    assert s.meta.n_approaches in {3, 4}
    assert isinstance(s.meta.is_signalized, bool)


def test_labeled_sample_returns_labeled_sample_dataclass():
    s = generate_labeled_sample(np.random.default_rng(0))
    assert isinstance(s, LabeledSample)


def test_sample_intersection_modifier_returns_length_4_float_array():
    mod = sample_intersection_modifier(np.random.default_rng(0))
    assert isinstance(mod, np.ndarray)
    assert mod.shape == (N_VEHICLE_CHANNELS,)
    assert mod.dtype == np.float64
    assert np.all(mod > 0.0)


def test_weekend_flag_propagates_into_labeled_sample():
    s_wd = generate_labeled_sample(np.random.default_rng(0), is_weekend=False)
    s_we = generate_labeled_sample(np.random.default_rng(0), is_weekend=True)
    assert s_wd.is_weekend is False
    assert s_we.is_weekend is True


# ── Class-balance sanity ─────────────────────────────────────────────────────

# Standing fixture for the class-balance checks: one fixed seed, one fixed
# sample size, weekday/weekend mix matching a 5/7 week. Module-scoped so the
# 500-sample sweep runs once and is shared by every class-balance test.

_BALANCE_SEED = 42
_BALANCE_N = 500


@pytest.fixture(scope="module")
def intervention_distribution() -> dict[str, float]:
    rng = np.random.default_rng(_BALANCE_SEED)
    samples = [
        generate_labeled_sample(rng, is_weekend=(i % 7) >= 5)
        for i in range(_BALANCE_N)
    ]
    counts = Counter(s.intervention for s in samples)
    return {cls: counts.get(cls, 0) / _BALANCE_N for cls in INTERVENTION_CLASSES}


def test_intervention_distribution_covers_all_three_classes(intervention_distribution):
    # Every intervention class should appear at least once in a 500-sample
    # weekday/weekend mix. If any class is zero, the generator is broken or
    # its calibration has drifted far from the PRD design.
    for cls in INTERVENTION_CLASSES:
        assert intervention_distribution[cls] > 0.0, (
            f"intervention class {cls!r} never appears in {_BALANCE_N} samples"
        )


def test_intervention_distribution_timing_only_dominates_per_prd(
    intervention_distribution,
):
    # PRD §Implementation Decisions / Class imbalance: "mild class imbalance
    # (~50–65% timing_only)". Per §Testing Decisions allow a ±10pp band.
    p = intervention_distribution["timing_only"]
    assert 0.40 <= p <= 0.75, (
        f"timing_only proportion {p:.3f} outside the PRD-derived band [0.40, 0.75]"
    )


def test_intervention_distribution_road_widening_is_sparse(
    intervention_distribution,
):
    # PRD §Risks: "road_widening class may be sparse (<10% of samples)".
    # Allow a small headroom (up to 15%) for stochastic variation.
    p = intervention_distribution["road_widening"]
    assert p <= 0.15, (
        f"road_widening proportion {p:.3f} exceeds the PRD-derived ceiling 0.15"
    )


def test_intervention_distribution_signalize_in_realistic_range(
    intervention_distribution,
):
    # Whatever timing_only and road_widening do not consume falls to
    # signalize. With timing_only ∈ [0.50, 0.65] and road_widening < 0.10,
    # signalize should land roughly in [0.25, 0.45]; allow a wider band so
    # the test guards against catastrophic drift (signalize → 0 or 1) but
    # tolerates ordinary calibration tweaks.
    p = intervention_distribution["signalize"]
    assert 0.15 <= p <= 0.55, (
        f"signalize proportion {p:.3f} outside the realistic band [0.15, 0.55]"
    )


def test_intervention_distribution_sums_to_one(intervention_distribution):
    # Sanity: the three proportions exhaust the sample.
    total = sum(intervention_distribution.values())
    assert abs(total - 1.0) < 1e-9
