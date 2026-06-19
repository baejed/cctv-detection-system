/** Pure traffic-simulation primitives.
 *
 *  Lifted out of IntersectionScene3D so the rules - vehicle car-following,
 *  signal phase rotation, Poisson spawning - can be unit-tested without
 *  instantiating Three.js. The scene still owns the integration glue (mesh
 *  refs, scene lifecycle); this module owns the rules.
 *
 *  None of these functions allocate or read globals. They are safe to call
 *  from a render loop and equally safe to call from a vitest. */
import type { VehicleType, TypeFractions } from '@/components/IntersectionCanvas';

// ── Signal phase rotation ─────────────────────────────────────────────────

export const AMBER_S = 3;
export const ALL_RED = 3;

export type SignalPhase = 'red' | 'amber' | 'green';

/** Per-approach green durations, four-phase plan in SB → WB → NB → EB order. */
export type GreenTimes = [number, number, number, number];

export function phaseStart(appIdx: number, gTimes: GreenTimes): number {
  let t = 0;
  for (let i = 0; i < appIdx; i++) t += gTimes[i] + ALL_RED;
  return t;
}

export function phaseCycle(gTimes: GreenTimes): number {
  return gTimes.reduce((s, g) => s + g + ALL_RED, 0);
}

/** Return the phase a given approach is in at simulation time `t`.
 *  `signalOff` overrides everything to a blinking amber (per PH practice). */
export function approachPhase(
  appIdx: number, t: number,
  gTimes: GreenTimes,
  signalOff: boolean, blinkOn: boolean,
): SignalPhase {
  if (signalOff) return blinkOn ? 'amber' : 'red';
  const cycle = phaseCycle(gTimes);
  if (cycle <= 0 || !isFinite(cycle)) return 'red';
  const tMod  = ((t % cycle) + cycle) % cycle;
  const start = phaseStart(appIdx, gTimes);
  const end   = start + gTimes[appIdx];
  if (tMod < start || tMod >= end) return 'red';
  if (gTimes[appIdx] > AMBER_S && tMod >= end - AMBER_S) return 'amber';
  return 'green';
}

/** Seconds until the next phase boundary for `appIdx`. */
export function approachRemaining(appIdx: number, t: number, gTimes: GreenTimes): number {
  const cycle = phaseCycle(gTimes);
  if (cycle <= 0 || !isFinite(cycle)) return 0;
  const tMod  = ((t % cycle) + cycle) % cycle;
  const start = phaseStart(appIdx, gTimes);
  const end   = start + gTimes[appIdx];
  if (tMod >= start && tMod < end) return end - tMod;
  if (tMod <  start) return start - tMod;
  return cycle - tMod + start;
}

/** Pedestrian crossing is safe only when *both* conflicting approaches are
 *  fully red. Pass the two approach indices that block this crosswalk
 *  (NS crosswalks → [0,2]; EW crosswalks → [1,3]). */
export function pedCanWalk(
  conflictingApproaches: readonly number[],
  t: number,
  gTimes: GreenTimes,
  signalOff: boolean,
): boolean {
  if (signalOff) return false;
  return conflictingApproaches.every(ai =>
    approachPhase(ai, t, gTimes, false, false) === 'red'
  );
}

// ── Vehicle physics ───────────────────────────────────────────────────────

export interface VParams {
  /** vehicle length (m) - used for bumper-to-bumper gap calc */
  len:   number;
  /** desired free-flow speed (m/s) */
  spd:   number;
  /** comfortable acceleration (m/s²) */
  accel: number;
  /** comfortable deceleration (m/s²) - used as the IDM `b` term */
  dec:   number;
  /** minimum standstill gap (m) - the IDM `s0` term */
  gap:   number;
}

export const VPARAMS: Record<VehicleType, VParams> = {
  MC:    { len: 2.0,  spd: 22, accel: 3.0, dec: 7.5, gap: 1.5 },
  CAR:   { len: 4.4,  spd: 18, accel: 2.2, dec: 6.0, gap: 2.0 },
  JEP:   { len: 6.5,  spd: 14, accel: 1.5, dec: 5.0, gap: 2.5 },
  BUS:   { len: 11.0, spd: 11, accel: 1.0, dec: 3.5, gap: 3.5 },
  TRUCK: { len: 8.5,  spd: 11, accel: 1.2, dec: 3.5, gap: 3.0 },
};

export const VEH_TYPES: VehicleType[] = ['MC', 'CAR', 'JEP', 'BUS', 'TRUCK'];

export const DEFAULT_MIX: TypeFractions = {
  MC: 0.50, CAR: 0.30, JEP: 0.15, BUS: 0.03, TRUCK: 0.02,
};

/** Sample a vehicle type from a categorical mix. Rejects to CAR on a mix sum < 1
 *  so an under-specified mix never returns undefined. */
export function sampleType(mix: TypeFractions, rand: () => number = Math.random): VehicleType {
  let r = rand(), cum = 0;
  for (const t of VEH_TYPES) { cum += mix[t]; if (r < cum) return t; }
  return 'CAR';
}

/** Intelligent Driver Model acceleration term.
 *
 *  - `vLead === Infinity` (no leader and stop-line not active) means free-flow
 *    acceleration toward `p.spd`.
 *  - `gap` is the bumper-to-bumper distance in metres; clamped at 0.01 to avoid
 *    a divide-by-zero when vehicles overlap.
 *
 *  Returns m/s². Caller integrates: `v += acc * dt; v = max(0, v)`. */
export function idmAcceleration(
  p: VParams,
  v: number,
  vLead: number,
  gap: number,
): number {
  const dv    = v - (isFinite(vLead) ? vLead : 0);
  const sStar = p.gap + Math.max(0, v * 1.2 + v * dv / (2 * Math.sqrt(p.accel * p.dec)));
  return p.accel * (
    1
    - Math.pow(Math.max(v, 0) / p.spd, 4)
    - Math.pow(sStar / Math.max(gap, 0.01), 2)
  );
}

/** Time to the next Poisson arrival, in seconds, given an arrival rate in
 *  arrivals/second. Adds a small floor to the random draw so the log never
 *  returns -Infinity when rand() returns exactly 0. */
export function nextPoissonInterval(ratePerSecond: number, rand: () => number = Math.random): number {
  if (ratePerSecond <= 0) return Infinity;
  return -Math.log(rand() + 0.001) / ratePerSecond;
}
