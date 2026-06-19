import { Link } from 'react-router-dom';
import type { Intersection, Street } from '@/types';
import type { RecommendationResponse } from '@/services/recommendations';
import type { SimulationResponse } from '@/services/simulation';
import { selectPeakChunk } from '@/lib/simulation';
import {
  IMPROVEMENT_PROMINENT_VH,
  buildApproachRows,
  evaluateImprovement,
} from '@/lib/improvement';
import { Button } from '@/components/ui/button';
import { Wrench, TrendingDown, TrendingUp, Minus } from 'lucide-react';

function buildNarrative(
  intersection: Intersection,
  sim: SimulationResponse | null,
  rec: RecommendationResponse | null,
): string {
  const name = intersection.name;
  const signalized = intersection.signal_status !== 'unsignalized';

  if (!rec) {
    return `No analysis has been run yet for ${name}. Run a warrant analysis to generate a recommendation and timing plan.`;
  }

  // Unsignalized case
  if (!signalized) {
    if (rec.recommended) {
      const warrants: string[] = [];
      if (rec.warrant_1_met) warrants.push('peak-hour traffic volume');
      if (rec.warrant_2_met) warrants.push('four-hour traffic volume');
      if (rec.warrant_4_met) warrants.push('pedestrian volume');
      const because = warrants.length > 0
        ? ` It meets the threshold for ${warrants.join(' and ')}.`
        : '';
      return `${name} has enough traffic to justify installing a traffic signal.${because} Installing a signal is recommended; without one, drivers experience long waits and uncoordinated gaps at peak hours.`;
    }
    return `${name} does not currently have enough traffic to justify a new traffic signal. The intersection can stay as-is; recheck if volumes grow over time.`;
  }

  // Signalized case - compare before/after
  const summary = evaluateImprovement(sim);
  if (!summary) {
    return `${name} is already signalized but no simulation data is available yet to compare current timing against an optimized plan. Run analysis to see whether re-timing would help.`;
  }

  const saved  = Math.round(summary.vehicleHoursSavedPerDay);
  const before = Math.round(summary.delayBeforeS);
  const after  = Math.round(summary.delayAfterS);

  if (!summary.worthHighlighting) {
    return `${name} is already running close to an optimal timing plan. Average wait per car is about ${before}s (level of service ${summary.losBefore}), and re-timing would save fewer than ${IMPROVEMENT_PROMINENT_VH} vehicle-hours of delay per day - not worth changing.`;
  }

  const losPart = summary.levelOfServiceChanged
    ? ` Level of service would improve from ${summary.losBefore} to ${summary.losAfter}.`
    : '';
  return `${name} is signalized but the current timing is not optimal. A recalculated plan would cut average wait from ${before}s to ${after}s per car and save about ${saved} vehicle-hours of delay per day.${losPart} Re-timing is recommended; a new signal is not needed.`;
}

export interface IntersectionSummaryProps {
  intersection: Intersection;
  streets: Street[];
  sim: SimulationResponse | null;
  rec: RecommendationResponse | null;
  /** Hide the print-only sections (useful inside SignalTiming where print is already wired) */
  noPrint?: boolean;
}

export function IntersectionSummary({ intersection, streets, sim, rec, noPrint }: IntersectionSummaryProps) {
  const peakChunk = selectPeakChunk(sim);
  const rows = buildApproachRows(
    streets,
    intersection.existing_green_splits,
    peakChunk?.proposed_splits,
  );
  const hasAnyDelta = rows.some(r => r.deltaSeconds != null && Math.abs(r.deltaSeconds) >= 2);
  const narrative = buildNarrative(intersection, sim, rec);

  const timingHref = `/intersections/${intersection.id}/timing?edit=1`;

  return (
    <div className={noPrint ? 'flex flex-col gap-4' : 'flex flex-col gap-4 print:gap-2'}>
      {/* Narrative summary - prose paragraph (bottom of print/report) */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 print:p-3 print:break-inside-avoid bg-white">
        <h3 className="text-md font-semibold text-muted-foreground uppercase tracking-wide mb-2 print:mb-1">
          Summary
        </h3>
        <p className="text-sm leading-relaxed print:text-xs">{narrative}</p>
      </div>
    </div>
  );
}
