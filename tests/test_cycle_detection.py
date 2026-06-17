"""Unit tests for the signal cycle detection estimator."""
import math
import pytest

from server.cycle_detection import _pearson_r, estimate_signal_timing


# ── _pearson_r ────────────────────────────────────────────────────────────────

def test_pearson_r_perfect_positive():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert abs(_pearson_r(x, x) - 1.0) < 1e-9


def test_pearson_r_perfect_negative():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [5.0, 4.0, 3.0, 2.0, 1.0]
    assert abs(_pearson_r(x, y) - (-1.0)) < 1e-9


def test_pearson_r_uncorrelated():
    """Constant series → undefined correlation → returns 0."""
    x = [1.0] * 10
    y = [2.0] * 10
    assert _pearson_r(x, y) == 0.0


def test_pearson_r_too_short():
    assert _pearson_r([1.0], [1.0]) == 0.0


def test_pearson_r_range():
    import random
    random.seed(42)
    x = [random.gauss(0, 1) for _ in range(50)]
    y = [random.gauss(0, 1) for _ in range(50)]
    r = _pearson_r(x, y)
    assert -1.0 <= r <= 1.0


# ── estimate_signal_timing with mock DB ───────────────────────────────────────

class _Row:
    def __init__(self, street_id, minute, count):
        self.street_id = street_id
        self.minute    = minute
        self.count     = count


def _make_mock_db(rows):
    """Minimal mock that returns the given rows from db.execute().fetchall()."""
    class _Result:
        def __init__(self, data):
            self._data = data
        def fetchall(self):
            return self._data

    class _MockDB:
        def execute(self, *args, **kwargs):
            return _Result(rows)

    return _MockDB()


def test_no_data_returns_low_confidence():
    db = _make_mock_db([])
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["confidence"] == "low"
    assert result["estimated_cycle_s"] is None


def test_too_few_windows_returns_low_confidence():
    rows = [_Row(1, i, 10) for i in range(10)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["confidence"] == "low"
    assert result["estimated_cycle_s"] is None


def test_all_zero_counts_returns_low_confidence():
    rows = [_Row(1, i, 0) for i in range(60)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["confidence"] == "low"
    assert result["estimated_cycle_s"] is None


def test_120s_cycle_detected_at_lag_2():
    """A 120 s signal (60 s green + 60 s red, minute-aligned) produces an [H, L, H, L]
    series with autocorrelation period 2 minutes.  Lag 1 is negative; lag 2 is the
    first positive peak."""
    # [H, L, H, L, ...] - each minute is cleanly one phase (120 s cycle, equal split)
    counts = [50 if i % 2 == 0 else 5 for i in range(120)]
    rows = [_Row(1, i, counts[i]) for i in range(120)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["best_lag_min"] == 2
    assert result["best_autocorr"] is not None and result["best_autocorr"] > 0
    assert result["estimated_cycle_s"] == 120


def test_4min_period_detected_at_lag_4():
    """A 4-minute repeating pattern (e.g. 80 s cycle) is detected at lag 4."""
    # [H, H, L, L, H, H, L, L, ...] - period = 4 min
    counts = [50 if (i // 2) % 2 == 0 else 5 for i in range(120)]
    rows = [_Row(1, i, counts[i]) for i in range(120)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["best_lag_min"] == 4


def test_90s_cycle_detected_at_lag_3():
    """A 3-minute repeating pattern (= 2×90s) should show highest autocorr at lag 3."""
    # 90s cycle: high for 1.5 min, low for 1.5 min - represented as
    # 3-minute block: [high, mixed, low] repeating
    # Approximation with 1-minute resolution: repeat [50, 25, 5] every 3 minutes
    counts = ([50, 25, 5] * 40)[:120]
    rows = [_Row(1, i, counts[i]) for i in range(120)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["best_lag_min"] == 3
    assert result["estimated_cycle_s"] == 90


def test_result_has_required_keys():
    rows = [_Row(1, i, 10 + (5 if i % 2 == 0 else -5)) for i in range(60)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    for key in ("estimated_cycle_s", "confidence", "note", "dispersion_index",
                "best_lag_min", "best_autocorr"):
        assert key in result, f"Missing key: {key}"


def test_confidence_values_are_valid():
    rows = [_Row(1, i, 10) for i in range(60)]
    db = _make_mock_db(rows)
    result = estimate_signal_timing(db, intersection_id=1)
    assert result["confidence"] in ("low", "medium", "high")
