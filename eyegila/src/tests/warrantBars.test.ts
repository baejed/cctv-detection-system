import { describe, it, expect } from 'vitest';
import { BARS, resolveBar, type BarKey } from '../components/recommendations/LatestTab';

const BASE = {
  warrant_1_met: false, warrant_1_confidence: 0.10,
  warrant_2_met: false, warrant_2_confidence: 0.20,
  warrant_4_met: true,  warrant_4_confidence: 0.85,
  w_local_2_met: true,  w_local_2_confidence: 0.65,
  w_local_3_met: false, w_local_3_confidence: 0.30,
  recommended: true, recommended_confidence: 0.78,
};

describe('BARS catalog', () => {
  it('exposes the six warrant-and-overall rows the multi-task CNN predicts', () => {
    expect(BARS.map(b => b.key)).toEqual([
      'warrant_1', 'warrant_2', 'warrant_4',
      'w_local_2', 'w_local_3', 'recommended',
    ]);
  });

  it('every bar has a non-empty human-readable label', () => {
    for (const b of BARS) expect(b.label.trim().length).toBeGreaterThan(0);
  });
});

describe('resolveBar()', () => {
  it('returns the matching confidence + met flag for each MUTCD warrant', () => {
    expect(resolveBar(BASE, 'warrant_1')).toEqual({ value: 0.10, met: false });
    expect(resolveBar(BASE, 'warrant_2')).toEqual({ value: 0.20, met: false });
    expect(resolveBar(BASE, 'warrant_4')).toEqual({ value: 0.85, met: true  });
  });

  it('resolves the two Tagum-local warrants when populated', () => {
    expect(resolveBar(BASE, 'w_local_2')).toEqual({ value: 0.65, met: true  });
    expect(resolveBar(BASE, 'w_local_3')).toEqual({ value: 0.30, met: false });
  });

  it('uses recommended_confidence and the recommended flag for the overall bar', () => {
    expect(resolveBar(BASE, 'recommended')).toEqual({ value: 0.78, met: true });
  });

  it('hides a local-warrant bar when its confidence is null', () => {
    expect(resolveBar({ ...BASE, w_local_2_confidence: null }, 'w_local_2')).toBeNull();
    expect(resolveBar({ ...BASE, w_local_3_confidence: null }, 'w_local_3')).toBeNull();
  });

  it('treats a null met flag as false when confidence is still present', () => {
    const rec = { ...BASE, w_local_2_met: null, w_local_2_confidence: 0.4 };
    expect(resolveBar(rec, 'w_local_2')).toEqual({ value: 0.4, met: false });
  });

  it('hides the overall bar when recommended_confidence is null', () => {
    expect(resolveBar({ ...BASE, recommended_confidence: null }, 'recommended')).toBeNull();
  });

  it('renders all six rows for a fully-populated recommendation', () => {
    const visible = BARS.map(b => resolveBar(BASE, b.key as BarKey)).filter(Boolean);
    expect(visible).toHaveLength(6);
  });

  it('renders only the MUTCD bars when the local-warrant pipeline did not run', () => {
    const legacy = {
      ...BASE,
      w_local_2_met: null, w_local_2_confidence: null,
      w_local_3_met: null, w_local_3_confidence: null,
    };
    const visibleKeys = BARS
      .filter(b => resolveBar(legacy, b.key) !== null)
      .map(b => b.key);
    expect(visibleKeys).toEqual(['warrant_1', 'warrant_2', 'warrant_4', 'recommended']);
  });
});
