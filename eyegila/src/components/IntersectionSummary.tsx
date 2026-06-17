import { Link } from 'react-router-dom';
import type { Intersection, Street } from '@/types';
import type { RecommendationResponse } from '@/services/recommendations';
import type { SimulationResponse, SimulationChunk } from '@/services/simulation';
import { Button } from '@/components/ui/button';
import { Wrench, TrendingDown, TrendingUp, Minus } from 'lucide-react';

interface ApproachRow {
  streetId: number;
  label: string;
  currentGreen: number | null;
  recommendedGreen: number | null;
  deltaSeconds: number | null;
}

function pickPeakChunk(sim: SimulationResponse | null): SimulationChunk | null {
  if (!sim || sim.chunks.length === 0) return null;
  return [...sim.chunks].sort((a, b) => b.volume_pcu_hr - a.volume_pcu_hr)[0] ?? null;
}

function buildApproachRows(
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
  if (!sim) {
    return `${name} is already signalized but no simulation data is available yet to compare current timing against an optimized plan. Run analysis to see whether re-timing would help.`;
  }

  const ds = sim.daily_summary;
  const saved = Math.round(ds.total_vehicle_hours_saved ?? 0);
  const before = Math.round(ds.avg_delay_before ?? 0);
  const after  = Math.round(ds.avg_delay_after ?? 0);
  const losBefore = ds.los_before;
  const losAfter  = ds.los_after;

  // Threshold below which we consider current timing fine
  if (saved < 10) {
    return `${name} is already running close to an optimal timing plan. Average wait per car is about ${before}s (level of service ${losBefore}), and re-timing would save fewer than 10 vehicle-hours of delay per day - not worth changing.`;
  }

  const losPart = losBefore && losAfter && losBefore !== losAfter
    ? ` Level of service would improve from ${losBefore} to ${losAfter}.`
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
  const peakChunk = pickPeakChunk(sim);
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
      {/* Action card - per-approach rows */}
      <div className="rounded-lg border border-border bg-card p-4 print:p-3 print:break-inside-avoid">
        <div className="flex items-center justify-between gap-2 mb-3 print:mb-2">
          <div>
            <h2 className="text-sm font-semibold">Recommended changes by approach</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {hasAnyDelta
                ? 'Adjust the green time on each approach to match the recommended plan.'
                : 'No meaningful changes required at this intersection.'}
            </p>
          </div>
          {hasAnyDelta && (
            <Button asChild size="sm" className="h-7 text-xs gap-1.5 print:hidden">
              <Link to={timingHref}>
                <Wrench className="size-3" />
                Fix in signal timing
              </Link>
            </Button>
          )}
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No streets configured for this intersection.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map(r => {
              const noData = r.currentGreen == null || r.recommendedGreen == null;
              const delta = r.deltaSeconds;
              const noChange = delta != null && Math.abs(delta) < 2;
              const Icon = delta == null || noChange ? Minus : delta > 0 ? TrendingUp : TrendingDown;
              const tone = delta == null || noChange
                ? 'text-muted-foreground'
                : delta > 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-teal-600 dark:text-teal-400';
              return (
                <div
                  key={r.streetId}
                  className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-xs"
                >
                  <span className="flex-1 font-medium truncate">{r.label}</span>
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {r.currentGreen != null ? `${r.currentGreen}s` : '—'}
                  </span>
                  <span className="text-muted-foreground/60">→</span>
                  <span className="font-mono tabular-nums">
                    {r.recommendedGreen != null ? `${r.recommendedGreen}s` : '—'}
                  </span>
                  <span className={`flex items-center gap-1 font-mono tabular-nums w-16 justify-end ${tone}`}>
                    <Icon className="size-3" />
                    {noData ? '—' : noChange ? 'OK' : `${delta! > 0 ? '+' : ''}${delta}s`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Narrative summary - prose paragraph (bottom of print/report) */}
      <div className="rounded-lg border border-border bg-muted/30 p-4 print:p-3 print:break-inside-avoid">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 print:mb-1">
          Summary
        </h3>
        <p className="text-sm leading-relaxed print:text-xs">{narrative}</p>
      </div>
    </div>
  );
}
