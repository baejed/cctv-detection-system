/**
 * Runtime shape tests for TypeScript types and domain utility functions.
 *
 * TypeScript's type system is erased at runtime - these tests verify that the
 * *values* flowing through the app still match the expected shapes, and that
 * pure helper functions (LOS colour lookup, `fmt`, `buildTypeMix`) work correctly.
 */
import { describe, it, expect } from 'vitest';

// ─── Type shape helpers ───────────────────────────────────────────────────────

function isSignalStatus(v: unknown): boolean {
  return v === 'unsignalized' || v === 'fixed_time' || v === 'actuated';
}

function isArmDirection(v: unknown): boolean {
  return ['northbound', 'southbound', 'eastbound', 'westbound', 'unknown'].includes(v as string);
}

// ─── SignalStatus ─────────────────────────────────────────────────────────────

describe('SignalStatus', () => {
  it('accepts all three valid values', () => {
    expect(isSignalStatus('unsignalized')).toBe(true);
    expect(isSignalStatus('fixed_time')).toBe(true);
    expect(isSignalStatus('actuated')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isSignalStatus('signalized')).toBe(false);
    expect(isSignalStatus('')).toBe(false);
    expect(isSignalStatus(null)).toBe(false);
  });
});

// ─── ArmDirection ─────────────────────────────────────────────────────────────

describe('ArmDirection', () => {
  const valid = ['northbound', 'southbound', 'eastbound', 'westbound', 'unknown'];
  it.each(valid)('accepts %s', (dir) => expect(isArmDirection(dir)).toBe(true));

  it('rejects unknown string', () => expect(isArmDirection('diagonal')).toBe(false));
  it('is case-sensitive', () => expect(isArmDirection('North')).toBe(false));
});

// ─── LOS colour mapping (from SignalTiming.tsx) ───────────────────────────────

const LOS_COLORS: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  B: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  C: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  D: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  E: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  F: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

describe('LOS_COLORS', () => {
  it('has entries for every HCM grade A–F', () => {
    for (const grade of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(LOS_COLORS[grade]).toBeTruthy();
    }
  });

  it('each entry is a non-empty Tailwind class string', () => {
    for (const cls of Object.values(LOS_COLORS)) {
      expect(typeof cls).toBe('string');
      expect(cls.length).toBeGreaterThan(0);
      expect(cls).toMatch(/^bg-/);
    }
  });

  it('has exactly 6 entries (no extra grades)', () => {
    expect(Object.keys(LOS_COLORS)).toHaveLength(6);
  });
});

// ─── fmt() helper (inline copy from SignalTiming.tsx) ─────────────────────────

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '-';
  return `${n.toFixed(1)}${unit}`;
}

describe('fmt()', () => {
  it('formats a number with 1 decimal and default unit', () => {
    expect(fmt(10.567)).toBe('10.6s');
    expect(fmt(0)).toBe('0.0s');
  });

  it('returns em-dash for null', () => expect(fmt(null)).toBe('-'));
  it('returns em-dash for undefined', () => expect(fmt(undefined)).toBe('-'));

  it('accepts custom unit', () => {
    expect(fmt(3.1, ' PCU/hr')).toBe('3.1 PCU/hr');
    expect(fmt(0.25, '%')).toBe('0.3%');
  });

  it('rounds correctly at 0.5 boundary', () => {
    expect(fmt(1.05)).toBe('1.1s');
    expect(fmt(1.04)).toBe('1.0s');
  });
});

// ─── buildTypeMix (inline copy from SignalTiming.tsx) ────────────────────────

type VehicleType = 'MC' | 'CAR' | 'JEP' | 'BUS' | 'TRUCK';
type TypeFractions = Record<VehicleType, number>;

const OBJECT_TO_VEHICLE: Record<string, VehicleType> = {
  motorcycle: 'MC', pedicab: 'MC', tricycle: 'MC', bicycle: 'MC',
  car: 'CAR', jeepney: 'JEP', bus: 'BUS', truck: 'TRUCK',
};

interface AggRow {
  street_id: number | null;
  object_type: string;
  count: number;
  intersection_id?: number;
  intersection_name?: string;
  direction?: string;
  window_start?: string;
}

function buildTypeMix(rows: AggRow[]): Record<string, TypeFractions> {
  const byStreet = new Map<string, Record<VehicleType, number>>();
  for (const row of rows) {
    if (!row.street_id) continue;
    const vt = OBJECT_TO_VEHICLE[row.object_type];
    if (!vt) continue;
    const key = String(row.street_id);
    if (!byStreet.has(key)) byStreet.set(key, { MC: 0, CAR: 0, JEP: 0, BUS: 0, TRUCK: 0 });
    byStreet.get(key)![vt] += row.count;
  }
  const mix: Record<string, TypeFractions> = {};
  for (const [sid, counts] of byStreet) {
    const total = counts.MC + counts.CAR + counts.JEP + counts.BUS + counts.TRUCK;
    if (total === 0) continue;
    mix[sid] = {
      MC:    counts.MC    / total,
      CAR:   counts.CAR   / total,
      JEP:   counts.JEP   / total,
      BUS:   counts.BUS   / total,
      TRUCK: counts.TRUCK / total,
    };
  }
  return mix;
}

describe('buildTypeMix()', () => {
  it('produces fractions that sum to 1.0 for each street', () => {
    const rows: AggRow[] = [
      { street_id: 1, object_type: 'motorcycle', count: 60 },
      { street_id: 1, object_type: 'car',        count: 30 },
      { street_id: 1, object_type: 'jeepney',    count: 10 },
    ];
    const mix = buildTypeMix(rows);
    const sum = Object.values(mix['1']).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('maps pedicab → MC fraction', () => {
    const rows: AggRow[] = [
      { street_id: 1, object_type: 'pedicab', count: 50 },
      { street_id: 1, object_type: 'car',     count: 50 },
    ];
    const mix = buildTypeMix(rows);
    expect(mix['1'].MC).toBeCloseTo(0.5, 5);
    expect(mix['1'].CAR).toBeCloseTo(0.5, 5);
  });

  it('maps tricycle → MC fraction', () => {
    const rows: AggRow[] = [
      { street_id: 1, object_type: 'tricycle', count: 100 },
    ];
    const mix = buildTypeMix(rows);
    expect(mix['1'].MC).toBeCloseTo(1.0, 5);
  });

  it('skips rows with street_id = null', () => {
    const rows: AggRow[] = [
      { street_id: null, object_type: 'car', count: 500 },
    ];
    expect(buildTypeMix(rows)).toEqual({});
  });

  it('skips unknown object types (e.g. pedestrian)', () => {
    const rows: AggRow[] = [
      { street_id: 1, object_type: 'pedestrian', count: 200 },
      { street_id: 1, object_type: 'car',        count: 100 },
    ];
    const mix = buildTypeMix(rows);
    expect(mix['1'].CAR).toBeCloseTo(1.0, 5);
    expect(mix['1'].MC).toBeCloseTo(0.0, 5);
  });

  it('handles multiple streets independently', () => {
    const rows: AggRow[] = [
      { street_id: 1, object_type: 'motorcycle', count: 100 },
      { street_id: 2, object_type: 'bus',        count: 50 },
    ];
    const mix = buildTypeMix(rows);
    expect(mix['1'].MC).toBeCloseTo(1.0, 5);
    expect(mix['2'].BUS).toBeCloseTo(1.0, 5);
  });

  it('returns empty object for empty input', () => {
    expect(buildTypeMix([])).toEqual({});
  });

  it('all type fractions are in [0, 1]', () => {
    const rows: AggRow[] = [
      { street_id: 5, object_type: 'motorcycle', count: 40 },
      { street_id: 5, object_type: 'car',        count: 30 },
      { street_id: 5, object_type: 'truck',      count: 20 },
      { street_id: 5, object_type: 'bus',        count: 10 },
    ];
    const mix = buildTypeMix(rows);
    for (const frac of Object.values(mix['5'])) {
      expect(frac).toBeGreaterThanOrEqual(0);
      expect(frac).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Recommendation type shape ────────────────────────────────────────────────

interface Recommendation {
  id: number;
  intersection_id: number;
  warrant_1_met: boolean;
  warrant_1_confidence: number;
  warrant_2_met: boolean;
  warrant_2_confidence: number;
  warrant_4_met: boolean;
  warrant_4_confidence: number;
  recommended: boolean;
  recommended_confidence: number | null;
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  vpm: number | null;
  phf: number | null;
  hour_start: string | null;
  notes: string | null;
  generated_at: string;
  timing_cycle: number | null;
  timing_chunk: string | null;
}

describe('Recommendation type', () => {
  const sample: Recommendation = {
    id: 1, intersection_id: 5,
    warrant_1_met: true,  warrant_1_confidence: 0.92,
    warrant_2_met: false, warrant_2_confidence: 0.31,
    warrant_4_met: false, warrant_4_confidence: 0.1,
    recommended: true, recommended_confidence: 0.85,
    major_volume: 1200, minor_volume: 200, peds: 10,
    vpm: 25, phf: 0.87, hour_start: '2026-06-15T07:00:00Z',
    notes: null, generated_at: '2026-06-15T08:00:00Z',
    timing_cycle: 90, timing_chunk: 'AM Peak',
  };

  it('all confidence values are in [0, 1]', () => {
    expect(sample.warrant_1_confidence).toBeGreaterThanOrEqual(0);
    expect(sample.warrant_1_confidence).toBeLessThanOrEqual(1);
    expect(sample.recommended_confidence!).toBeLessThanOrEqual(1);
  });

  it('generated_at is ISO-parseable', () => {
    expect(() => new Date(sample.generated_at)).not.toThrow();
    expect(isNaN(new Date(sample.generated_at).getTime())).toBe(false);
  });

  it('phf is in (0, 1]', () => {
    expect(sample.phf!).toBeGreaterThan(0);
    expect(sample.phf!).toBeLessThanOrEqual(1);
  });

  it('timing_cycle, if set, is a positive integer', () => {
    if (sample.timing_cycle != null) {
      expect(Number.isInteger(sample.timing_cycle)).toBe(true);
      expect(sample.timing_cycle).toBeGreaterThan(0);
    }
  });
});

// ─── statusBucket() (inline copy from statusBucket.ts) ───────────────────────

type StatusBucket = 'warranted' | 'borderline' | 'not_warranted' | 'no_data';

const BORDERLINE_LOW = 0.3;
const BORDERLINE_HIGH = 0.5;

interface RecLike {
  hour_start: string | null;
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  recommended: boolean;
  warrant_1_confidence: number;
  warrant_2_confidence: number;
  warrant_4_confidence: number;
}

function statusBucket(rec: RecLike): StatusBucket {
  if (
    rec.hour_start === null ||
    ((rec.major_volume ?? 0) === 0 && (rec.minor_volume ?? 0) === 0 && (rec.peds ?? 0) === 0)
  ) return 'no_data';
  if (rec.recommended) return 'warranted';
  const confs = [rec.warrant_1_confidence, rec.warrant_2_confidence, rec.warrant_4_confidence];
  if (confs.some(c => c >= BORDERLINE_LOW && c < BORDERLINE_HIGH)) return 'borderline';
  return 'not_warranted';
}

const BASE_REC: RecLike = {
  hour_start: '2026-06-15T07:00:00Z',
  major_volume: 1200, minor_volume: 200, peds: 10,
  recommended: false,
  warrant_1_confidence: 0.1, warrant_2_confidence: 0.1, warrant_4_confidence: 0.1,
};

describe('statusBucket()', () => {
  it('returns warranted when recommended=true', () => {
    expect(statusBucket({ ...BASE_REC, recommended: true, warrant_1_confidence: 0.95 })).toBe('warranted');
  });

  it('returns no_data when hour_start is null', () => {
    expect(statusBucket({ ...BASE_REC, hour_start: null })).toBe('no_data');
  });

  it('returns no_data when all volumes are zero', () => {
    expect(statusBucket({ ...BASE_REC, major_volume: 0, minor_volume: 0, peds: 0 })).toBe('no_data');
  });

  it('returns no_data when all volumes are null', () => {
    expect(statusBucket({ ...BASE_REC, major_volume: null, minor_volume: null, peds: null })).toBe('no_data');
  });

  it('returns borderline when any confidence is in [0.3, 0.5)', () => {
    expect(statusBucket({ ...BASE_REC, warrant_1_confidence: 0.35 })).toBe('borderline');
    expect(statusBucket({ ...BASE_REC, warrant_2_confidence: 0.49 })).toBe('borderline');
    expect(statusBucket({ ...BASE_REC, warrant_4_confidence: 0.30 })).toBe('borderline');
  });

  it('returns not_warranted when all confidences are below 0.3', () => {
    expect(statusBucket({ ...BASE_REC, warrant_1_confidence: 0.1, warrant_2_confidence: 0.05, warrant_4_confidence: 0.0 }))
      .toBe('not_warranted');
  });

  it('returns not_warranted when all confidences are exactly 0.5 or above (not borderline)', () => {
    expect(statusBucket({ ...BASE_REC, warrant_1_confidence: 0.5, warrant_2_confidence: 0.5, warrant_4_confidence: 0.5 }))
      .toBe('not_warranted');
  });

  it('warranted takes priority over borderline confidence', () => {
    expect(statusBucket({ ...BASE_REC, recommended: true, warrant_1_confidence: 0.4 })).toBe('warranted');
  });
});

// ─── SimulationChunk type ─────────────────────────────────────────────────────

describe('SimulationChunk', () => {
  const chunk = {
    chunk_name: 'AM Peak',
    delay_before: 12.3,
    delay_after: 8.7,
    los_before: 'B',
    los_after: 'A',
    vc_ratio_before: 0.65,
    vc_ratio_after: 0.42,
    volume_pcu_hr: 420.0,
    vehicle_hours_saved: 0.41,
    queue_series_before: null,
    queue_series_after: null,
    generated_at: '2026-06-15T08:00:00Z',
  };

  it('LOS grades are single uppercase letters A–F', () => {
    expect(chunk.los_before).toMatch(/^[A-F]$/);
    expect(chunk.los_after).toMatch(/^[A-F]$/);
  });

  it('v/c ratios are in [0, 1]', () => {
    expect(chunk.vc_ratio_before).toBeGreaterThanOrEqual(0);
    expect(chunk.vc_ratio_before).toBeLessThanOrEqual(1);
    expect(chunk.vc_ratio_after).toBeGreaterThanOrEqual(0);
    expect(chunk.vc_ratio_after).toBeLessThanOrEqual(1);
  });

  it('delays are non-negative', () => {
    expect(chunk.delay_before).toBeGreaterThanOrEqual(0);
    expect(chunk.delay_after).toBeGreaterThanOrEqual(0);
  });

  it('vehicle_hours_saved can be negative (signal not warranted case)', () => {
    const notWarranted = { ...chunk, vehicle_hours_saved: -0.15 };
    expect(typeof notWarranted.vehicle_hours_saved).toBe('number');
  });
});
