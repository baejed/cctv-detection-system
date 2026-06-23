import type { Street } from '@/types';
import type { SimulationResponse } from '@/services/simulation';

// Mirror of server/improvement.py:IMPROVEMENT_THRESHOLD_S - per-chunk delay
// saving (s/veh) that must be met for a re-timing to be saved. Kept here so the
// frontend can explain why a plan was dropped; raise both sides together.
export const IMPROVEMENT_THRESHOLD_S = 0.5;

// Aggregate vehicle-hours/day below which we treat the saving as cosmetic - the
// narrative says "near-optimal" instead of "re-timing recommended". This is a
// presentation rule (not the persistence rule the server uses).
export const IMPROVEMENT_PROMINENT_VH = 10;

export interface ApproachRow {
  streetId: number;
  label: string;
  currentGreen: number | null;
  recommendedGreen: number | null;
  deltaSeconds: number | null;
}

export function buildApproachRows(
  streets: Street[],
  existingSplits: Record<string, number> | null | undefined,
  proposedSplits: Record<string, number> | null | undefined,
): ApproachRow[] {
  return streets.map(s => {
    const key = String(s.id);
    const current = existingSplits?.[key] ?? null;
    const recommended = proposedSplits?.[key] ?? null;
    const delta = current != null && recommended != null ? recommended - current : null;
    const dirLabel = s.arm_direction !== 'unknown'
      ? s.arm_direction.replace('bound', '').toUpperCase()
      : '';
    const label = dirLabel ? `${dirLabel} - ${s.name}` : s.name;
    return { streetId: s.id, label, currentGreen: current, recommendedGreen: recommended, deltaSeconds: delta };
  });
}

export interface ImprovementSummary {
  vehicleHoursSavedPerDay: number;
  delayBeforeS: number;
  delayAfterS: number;
  levelOfServiceChanged: boolean;
  losBefore: string;
  losAfter: string;
  /** True when the saving is large enough to call out - drives the verdict copy. */
  worthHighlighting: boolean;
}

/** Summarise a simulation's headline improvement numbers in one place.
 *  The presentation threshold (`worthHighlighting`) is policy, not analysis -
 *  swap the constant above to retune what the UI calls "near-optimal".
 */
export function evaluateImprovement(sim: SimulationResponse | null): ImprovementSummary | null {
  if (!sim) return null;
  const ds = sim.daily_summary;
  const vh = ds.total_vehicle_hours_saved ?? 0;
  return {
    vehicleHoursSavedPerDay: vh,
    delayBeforeS:           ds.avg_delay_before,
    delayAfterS:            ds.avg_delay_after,
    losBefore:              ds.los_before,
    losAfter:               ds.los_after,
    levelOfServiceChanged:  !!ds.los_before && !!ds.los_after && ds.los_before !== ds.los_after,
    worthHighlighting:      vh >= IMPROVEMENT_PROMINENT_VH,
  };
}
