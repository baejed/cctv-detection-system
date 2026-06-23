import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell,
} from 'recharts';
import { type RecommendationResponse, type DataHealthResponse, recommendationsApi } from '@/services/recommendations';
import { aggregationApi } from '@/services/aggregation';
import type { AggregationRow } from '@/types';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Loader2, RefreshCw, Pencil, Check, X, BarChart2, Wifi, WifiOff, AlertTriangle, TrafficCone, Construction, Clock, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InterventionClass } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const W1_MAJOR_THRESHOLD = 400;
const W4_PEDS_THRESHOLD  = 100;

interface HourlyBucket { hour: number; label: string; volume: number; peds: number; }

function buildHourlyBuckets(rows: AggregationRow[]): HourlyBucket[] {
  const vehicleCounts: number[] = Array(24).fill(0);
  const pedCounts:     number[] = Array(24).fill(0);
  const PED_TYPES = new Set(['pedestrian', 'person', 'ped']);

  for (const row of rows) {
    const h = new Date(row.window_start).getHours();
    if (PED_TYPES.has(row.object_type)) {
      pedCounts[h] += row.count;
    } else {
      vehicleCounts[h] += row.count;
    }
  }

  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    label: h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`,
    volume: vehicleCounts[h],
    peds:   pedCounts[h],
  }));
}

interface WarrantChartProps {
  buckets: HourlyBucket[];
  threshold: number;
  dataKey: 'volume' | 'peds';
  thresholdLabel: string;
  qualifyingTarget: number;
}

function WarrantChart({ buckets, threshold, dataKey, thresholdLabel, qualifyingTarget }: WarrantChartProps) {
  const qualifying = buckets.filter(b => b[dataKey] >= threshold).length;
  const hasAnyData = buckets.some(b => b[dataKey] > 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">24-hour volume · threshold {thresholdLabel}</span>
        <span className={cn(
          'font-medium tabular-nums',
          qualifying >= qualifyingTarget ? 'text-emerald-600' : 'text-muted-foreground',
        )}>
          {qualifying}/{qualifyingTarget} qualifying hrs
        </span>
      </div>

      {hasAnyData ? (
        <ResponsiveContainer width="100%" height={80}>
          <BarChart data={buckets} margin={{ top: 4, right: 0, left: -28, bottom: 0 }} barCategoryGap="10%">
            <XAxis
              dataKey="label"
              tick={{ fontSize: 8, fill: 'currentColor' }}
              tickLine={false}
              axisLine={false}
              interval={5}
            />
            <YAxis
              tick={{ fontSize: 8, fill: 'currentColor' }}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
              formatter={(v) => [Number(v ?? 0), dataKey === 'peds' ? 'peds/hr' : 'veh/hr']}
              labelFormatter={(_: unknown, payload: readonly {payload?: HourlyBucket}[]) => {
                const b = payload?.[0]?.payload;
                return b ? `Hour ${b.hour}:00` : '';
              }}
            />
            <ReferenceLine
              y={threshold}
              stroke="#10b981"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              label={{ value: thresholdLabel, position: 'right', style: { fontSize: 8, fill: '#10b981' } }}
            />
            <Bar dataKey={dataKey} radius={[2, 2, 0, 0]}>
              {buckets.map((b, i) => (
                <Cell
                  key={i}
                  fill={b[dataKey] >= threshold ? '#10b981' : 'hsl(var(--muted-foreground) / 0.25)'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-20 rounded-md border border-dashed border-border bg-muted/20 flex items-center justify-center text-[10px] text-muted-foreground">
          No detection data for last 24 hours
        </div>
      )}
    </div>
  );
}

interface Props {
  rec: RecommendationResponse;
  onRegenerate: () => void;
  regenerating: boolean;
  onNotesSaved: (rec: RecommendationResponse) => void;
}

export type BarKey = 'warrant_1' | 'warrant_2' | 'warrant_4' | 'w_local_2' | 'w_local_3' | 'recommended';

export const BARS: { key: BarKey; label: string }[] = [
  { key: 'warrant_1',   label: 'W1 - Eight-Hour Vehicular Volume' },
  { key: 'warrant_2',   label: 'W2 - Four-Hour Vehicular Volume' },
  { key: 'warrant_4',   label: 'W4 - Pedestrian Volume' },
  { key: 'w_local_2',   label: 'W-Local 2 - Peak Concentration (Tagum)' },
  { key: 'w_local_3',   label: 'W-Local 3 - Lights Off (Tagum)' },
  { key: 'recommended', label: 'Overall recommended' },
];

interface BarSource {
  warrant_1_met: boolean; warrant_1_confidence: number;
  warrant_2_met: boolean; warrant_2_confidence: number;
  warrant_4_met: boolean; warrant_4_confidence: number;
  w_local_2_met: boolean | null; w_local_2_confidence: number | null;
  w_local_3_met: boolean | null; w_local_3_confidence: number | null;
  recommended: boolean; recommended_confidence: number | null;
}

export function resolveBar(rec: BarSource, key: BarKey): { value: number; met: boolean } | null {
  if (key === 'recommended') {
    if (rec.recommended_confidence == null) return null;
    return { value: rec.recommended_confidence, met: rec.recommended };
  }
  const value = rec[`${key}_confidence` as 'warrant_1_confidence'];
  if (value === null || value === undefined) return null;
  const met = rec[`${key}_met` as 'warrant_1_met'] ?? false;
  return { value, met };
}

export function LatestTab({ rec, onRegenerate, regenerating, onNotesSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rec.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<DataHealthResponse | null>(null);
  const [hourlyBuckets, setHourlyBuckets] = useState<HourlyBucket[] | null>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(rec.notes ?? '');
  }, [rec.id]);

  useEffect(() => {
    recommendationsApi.dataHealth(rec.intersection_id)
      .then(setHealth)
      .catch(() => null);

    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);
    aggregationApi.history({
      intersection_id: rec.intersection_id,
      start: start.toISOString(),
      end: end.toISOString(),
      bucket: 'hour',
    })
      .then(rows => setHourlyBuckets(buildHourlyBuckets(rows)))
      .catch(() => setHourlyBuckets([]));
  }, [rec.intersection_id]);

  async function save() {
    setSaving(true);
    try {
      const updated = await recommendationsApi.updateNotes(rec.id, draft.trim() || null);
      onNotesSaved(updated);
      setEditing(false);
      toast.success('Notes saved');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Hour analyzed: <span className="text-foreground">
            {rec.hour_start ? new Date(rec.hour_start).toLocaleString() : 'unknown'}
          </span>
          {rec.data_age_hours != null && rec.data_age_hours > 2 && (
            <span className="ml-2 text-amber-600 font-medium">
              ({rec.data_age_hours.toFixed(0)}h ago - stale)
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onRegenerate} disabled={regenerating} title="Analysis runs automatically every hour. Use this to force an immediate update.">
          {regenerating
            ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="size-3.5 mr-1.5" />}
          Run now
        </Button>
      </div>

      {/* Camera health */}
      {health && (
        <div className={cn(
          'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
          health.camera_ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/20 dark:border-emerald-900 dark:text-emerald-300'
            : 'border-rose-200 bg-rose-50 text-rose-800 dark:bg-rose-950/20 dark:border-rose-900 dark:text-rose-300',
        )}>
          {health.camera_ok
            ? <Wifi className="size-3.5 mt-0.5 shrink-0" />
            : <WifiOff className="size-3.5 mt-0.5 shrink-0" />}
          <span>
            {health.camera_ok
              ? `Camera live · last detection ${health.data_age_hours?.toFixed(1)}h ago`
              : health.last_detection_at
                ? `Camera offline · last detection ${health.data_age_hours?.toFixed(0)}h ago - counts may be unreliable`
                : 'No detections recorded - camera may not be configured'}
          </span>
        </div>
      )}

      {/* Recommended structural intervention (from multi-task CNN) */}
      {rec.intervention && <InterventionBanner intervention={rec.intervention} />}

      {/* Market-day / recurring spike warning */}
      {health && health.high_volume_days.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>{health.high_volume_days_note}</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {BARS.map(b => {
          const resolved = resolveBar(rec, b.key);
          if (!resolved) return null;
          const { value, met } = resolved;
          return (
            <div key={b.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className={cn(met && 'font-semibold')}>{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{(value * 100).toFixed(0)}%</span>
              </div>
              <Progress
                value={value * 100}
                className={cn('h-2', met ? '[&>div]:bg-emerald-500' : '[&>div]:bg-muted-foreground/40')}
              />
            </div>
          );
        })}
      </div>

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last-hour scalar summary</div>
          <div className="text-[10px] text-muted-foreground/70 italic">CNN reads the full 24h timeseries</div>
        </div>
        <div className="grid grid-cols-5 gap-3 text-center">
          <Stat label="Major" value={rec.major_volume} suffix="veh/hr" />
          <Stat label="Minor" value={rec.minor_volume} suffix="veh/hr" />
          <Stat label="Peds"  value={rec.peds}         suffix="/hr" />
          <Stat label="VPM"   value={rec.vpm}          suffix="" />
          <Stat label="PHF"   value={rec.phf}          suffix="" digits={2} />
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Warrant evidence (DPWH thresholds)</div>
          <WarrantInfoDialog />
        </div>

        {hourlyBuckets !== null && (
          <div className="flex flex-col gap-3">
            <WarrantChart
              buckets={hourlyBuckets}
              threshold={W1_MAJOR_THRESHOLD}
              dataKey="volume"
              thresholdLabel="≥400 veh/hr"
              qualifyingTarget={8}
            />
            {hourlyBuckets.some(b => b.peds > 0) && (
              <WarrantChart
                buckets={hourlyBuckets}
                threshold={W4_PEDS_THRESHOLD}
                dataKey="peds"
                thresholdLabel="≥100 ped/hr (W4)"
                qualifyingTarget={8}
              />
            )}
          </div>
        )}

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left pb-1 font-medium text-muted-foreground">Criterion</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Threshold</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Measured</th>
              <th className="text-right pb-1 font-medium text-muted-foreground">Met?</th>
            </tr>
          </thead>
          <tbody>
            <WarrantRow label="W1 - Major volume" threshold={400} measured={rec.major_volume} unit="veh/hr" />
            <WarrantRow label="W1 - Minor volume" threshold={150} measured={rec.minor_volume} unit="veh/hr" />
            <WarrantRow label="W4 - Pedestrians"  threshold={100} measured={rec.peds}         unit="/hr" />
          </tbody>
        </table>
        <p className="text-[10px] text-muted-foreground">
          DPWH Traffic Signal Manual Vol. 1 · Last-hour snapshot vs 24-hour hourly trend above
        </p>
      </div>

      <Separator />

      {/* Signal timing link */}
      <Link to={`/intersections/${rec.intersection_id}/timing`} className="block">
        <div className="rounded-md border border-border bg-card px-4 py-3 flex items-center justify-between hover:bg-muted/40 transition-colors">
          <div>
            <div className="text-xs font-medium">Signal timing &amp; simulation</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {rec.timing_cycle != null
                ? `${rec.timing_cycle}s cycle · peak chunk: ${rec.timing_chunk ?? '-'}`
                : 'Run analysis to compute timing'}
            </div>
          </div>
          <BarChart2 className="size-4 text-muted-foreground shrink-0" />
        </div>
      </Link>

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Engineer notes</div>
          {!editing && (
            <Button size="icon" variant="ghost" className="size-6" onClick={() => { setDraft(rec.notes ?? ''); setEditing(true); }} aria-label="Edit notes">
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="Engineer notes…"
              className="text-xs min-h-[100px]"
              autoFocus
            />
            <div className="flex gap-1.5 justify-end">
              <Button size="icon" variant="ghost" className="size-6" onClick={() => setEditing(false)} disabled={saving} aria-label="Cancel">
                <X className="size-3" />
              </Button>
              <Button size="icon" variant="ghost" className="size-6 text-emerald-600" onClick={save} disabled={saving} aria-label="Save">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn('text-xs leading-relaxed', rec.notes ? 'text-foreground' : 'text-muted-foreground/60 italic')}>
            {rec.notes ?? 'No notes'}
          </p>
        )}
      </div>
    </div>
  );
}

const INTERVENTION_META: Record<InterventionClass, {
  label: string;
  blurb: string;
  Icon: typeof TrafficCone;
  containerClass: string;
}> = {
  signalize: {
    label: 'Install traffic signal',
    blurb: 'Warrant met and intersection is currently unsignalized.',
    Icon: TrafficCone,
    containerClass: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/20 dark:border-emerald-900 dark:text-emerald-300',
  },
  road_widening: {
    label: 'Widen approach lanes',
    blurb: 'Post-Webster critical v/c exceeds 0.90 - signal timing alone cannot clear demand.',
    Icon: Construction,
    containerClass: 'border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:border-amber-900 dark:text-amber-300',
  },
  timing_only: {
    label: 'Timing adjustments only',
    blurb: 'No structural change recommended - existing signal timing can absorb the demand.',
    Icon: Clock,
    containerClass: 'border-border bg-muted/30 text-foreground',
  },
};

function InterventionBanner({ intervention }: { intervention: { class: InterventionClass; confidence: number } }) {
  const meta = INTERVENTION_META[intervention.class];
  const pct = Math.round(intervention.confidence * 100);
  return (
    <div className={cn('flex items-start gap-3 rounded-md border px-3 py-2.5', meta.containerClass)}>
      <meta.Icon className="size-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <div className="text-xs font-semibold">{meta.label}</div>
            <InterventionInfoDialog />
          </div>
          <div className="text-[10px] tabular-nums opacity-80">{pct}% confidence</div>
        </div>
        <div className="text-[10px] mt-0.5 opacity-80">{meta.blurb}</div>
      </div>
    </div>
  );
}

function InterventionInfoDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="How is this recommended?"
          className="opacity-60 hover:opacity-100 transition-opacity"
        >
          <Info className="size-3" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>How this recommendation is computed</DialogTitle>
          <DialogDescription>
            A multi-task 1D convolutional neural network reads the last 24 hours of
            per-approach flow (vehicle and pedestrian counts in 15-minute slots) plus
            intersection metadata, and outputs a single structural recommendation.
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs leading-relaxed text-muted-foreground space-y-3 mt-1">
          <div>
            <div className="font-semibold text-foreground mb-1 flex items-center gap-1.5">
              <TrafficCone className="size-3.5 text-emerald-600" /> Install traffic signal
            </div>
            Chosen when a MUTCD or Tagum-local warrant is met and the intersection is
            currently unsignalized. Existing signal timing cannot apply because there is no signal.
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1 flex items-center gap-1.5">
              <Construction className="size-3.5 text-amber-600" /> Widen approach lanes
            </div>
            Chosen when the post-Webster critical v/c ratio exceeds 0.90 - even an
            optimally-timed signal cannot clear demand, so a structural lane addition is
            needed.
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1 flex items-center gap-1.5">
              <Clock className="size-3.5 text-muted-foreground" /> Timing adjustments only
            </div>
            Default outcome: the intersection's demand can be absorbed by re-tuning the
            existing signal phases. No capex required.
          </div>
          <div className="pt-2 border-t border-border">
            <span className="font-semibold text-foreground">Confidence</span> is the
            softmax probability for the predicted class. Six warrant probabilities
            (W1, W2, W3, W4, W-Local 2, W-Local 3) are produced in parallel from the
            same network and surface in the bars below.
          </div>
          <div className="text-[10px] italic">
            Loss formulation: Kendall, Gal &amp; Cipolla (2018) homoscedastic
            uncertainty weighting. Trained on a ~5,400-sample parameter-realistic
            synthetic dataset with intersection-stratified splits.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, suffix, digits = 0 }: { label: string; value: number | null; suffix: string; digits?: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-2 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">
        {value === null ? '-' : digits > 0 ? value.toFixed(digits) : value}
      </div>
      {suffix && <div className="text-[9px] text-muted-foreground">{suffix}</div>}
    </div>
  );
}

function WarrantInfoDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="About these warrants"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <Info className="size-3" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>What the warrants mean</DialogTitle>
          <DialogDescription>
            The MUTCD (Manual on Uniform Traffic Control Devices) defines numerical
            tests for when a signal is justified. Tagum adds two local warrants for
            patterns the MUTCD does not cover.
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs leading-relaxed text-muted-foreground space-y-2.5 mt-1">
          <div>
            <span className="font-semibold text-foreground">W1 - Eight-Hour Vehicular Volume.</span>{' '}
            Major road ≥ 400 veh/hr and minor road ≥ 150 veh/hr for any 8 hours of the
            day. The most common American basis for signalization.
          </div>
          <div>
            <span className="font-semibold text-foreground">W2 - Four-Hour Vehicular Volume.</span>{' '}
            A lower-volume version of W1 over 4 hours. Captures intersections that
            barely miss W1 but still hit sustained peaks.
          </div>
          <div>
            <span className="font-semibold text-foreground">W3 - Peak Hour.</span>{' '}
            A single hour of very high delay or volume. Predicted by the CNN but not
            surfaced in the bars above because Tagum's 24/7 demand makes single-peak
            warrants rarely decisive.
          </div>
          <div>
            <span className="font-semibold text-foreground">W4 - Pedestrian Volume.</span>{' '}
            Pedestrian crossings ≥ 100/hr (≥ 75/hr if posted speed ≤ 40 km/h). Why we
            surface peds as a separate metric.
          </div>
          <div>
            <span className="font-semibold text-foreground">W-Local 2 - Peak Concentration.</span>{' '}
            Tagum-specific: the top two TOD chunks carry &gt; 60% of a day's vehicle
            volume. Catches "rush-only" intersections that benefit from peak-tuned
            timing rather than full signalization.
          </div>
          <div>
            <span className="font-semibold text-foreground">W-Local 3 - Lights Off.</span>{' '}
            Tagum-specific: avg PCU/hr per approach falls below 30 in any chunk -
            grounds for flashing-mode operation during that period rather than full
            cycles.
          </div>
          <div className="pt-2 border-t border-border">
            The 0.70 low-speed multiplier (MUTCD §4C.01) applies in Tagum on both
            counts: posted speed ≤ 40 km/h and population &lt; 10,000.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WarrantRow({ label, threshold, measured, unit }: {
  label: string; threshold: number; measured: number | null; unit: string;
}) {
  const met = measured !== null && measured >= threshold;
  return (
    <tr className="border-b border-border/50">
      <td className="py-1.5">{label}</td>
      <td className="text-right tabular-nums text-muted-foreground">≥ {threshold} {unit}</td>
      <td className={cn('text-right tabular-nums', measured === null ? 'text-muted-foreground' : met ? 'text-emerald-600 font-semibold' : 'text-rose-500')}>
        {measured !== null ? `${measured} ${unit}` : '-'}
      </td>
      <td className={cn('text-right', measured === null ? 'text-muted-foreground' : met ? 'text-emerald-600' : 'text-rose-500')}>
        {measured !== null ? (met ? '✓' : '✗') : '-'}
      </td>
    </tr>
  );
}
