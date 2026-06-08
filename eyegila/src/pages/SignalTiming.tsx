import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { simulationApi, type SimulationChunk, type SimulationResponse } from '@/services/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import { aggregationApi } from '@/services/aggregation';
import { DualIntersectionCanvas, type VehicleType, type TypeFractions } from '@/components/IntersectionCanvas';
import type { AggregationRow } from '@/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ArrowLeft, TrendingDown, Printer } from 'lucide-react';
import { cn } from '@/lib/utils';

const APPROACH_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

const OBJECT_TO_VEHICLE: Record<string, VehicleType> = {
  motorcycle: 'MC', pedicab: 'MC', tricycle: 'MC', bicycle: 'MC',
  car: 'CAR',
  jeepney: 'JEP',
  bus: 'BUS',
  truck: 'TRUCK',
};

function buildTypeMix(rows: AggregationRow[]): Record<string, TypeFractions> {
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
    const total = (counts.MC + counts.CAR + counts.JEP + counts.BUS + counts.TRUCK);
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

const LOS_COLORS: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  B: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  C: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  D: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  E: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  F: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

function LosBadge({ grade }: { grade: string }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums', LOS_COLORS[grade] ?? '')}>
      {grade}
    </span>
  );
}

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}${unit}`;
}

function fmtVc(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function deltaClass(before: number, after: number): string {
  return after < before ? 'text-emerald-600' : after > before ? 'text-rose-600' : '';
}

function buildQueueData(
  series: Record<string, number[]> | null,
  label: 'Before' | 'After',
): { minute: number; [key: string]: number }[] {
  if (!series) return [];
  const streetIds = Object.keys(series);
  const len = Math.max(...streetIds.map(k => series[k].length), 0);
  return Array.from({ length: len }, (_, i) => {
    const row: { minute: number; [key: string]: number } = { minute: i + 1 };
    for (const sid of streetIds) {
      row[`${label}_${sid}`] = series[sid][i] ?? 0;
    }
    return row;
  });
}

function mergeQueueData(
  before: Record<string, number[]> | null,
  after: Record<string, number[]> | null,
): { minute: number; [key: string]: number }[] {
  const beforeRows = buildQueueData(before, 'Before');
  const afterRows  = buildQueueData(after,  'After');
  const len = Math.max(beforeRows.length, afterRows.length);
  return Array.from({ length: len }, (_, i) => ({
    ...beforeRows[i],
    ...afterRows[i],
    minute: i + 1,
  }));
}

function ChunkQueueChart({ chunk, showBefore, showAfter }: {
  chunk: SimulationChunk;
  showBefore: boolean;
  showAfter: boolean;
}) {
  const data = mergeQueueData(chunk.queue_series_before, chunk.queue_series_after);
  if (!data.length) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No queue data available</p>;
  }

  const beforeKeys = showBefore && chunk.queue_series_before
    ? Object.keys(chunk.queue_series_before).map(sid => `Before_${sid}`)
    : [];
  const afterKeys = showAfter && chunk.queue_series_after
    ? Object.keys(chunk.queue_series_after).map(sid => `After_${sid}`)
    : [];
  const allKeys = [...beforeKeys, ...afterKeys];

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="minute"
          tick={{ fontSize: 11 }}
          tickFormatter={v => `${v}m`}
          label={{ value: 'Minute', position: 'insideBottomRight', offset: -4, fontSize: 11 }}
        />
        <YAxis tick={{ fontSize: 11 }} width={36} label={{ value: 'Queue', angle: -90, position: 'insideLeft', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ fontSize: 11 }}
          formatter={(v, name) => [`${Number(v).toFixed(1)} veh`, String(name ?? '').replace('_', ' Approach ')]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {allKeys.map((key, idx) => {
          const isBefore = key.startsWith('Before_');
          return (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={APPROACH_COLORS[idx % APPROACH_COLORS.length]}
              strokeWidth={1.5}
              strokeDasharray={isBefore ? '4 2' : undefined}
              dot={false}
              name={key.replace('Before_', 'Before A').replace('After_', 'After A')}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SignalTimingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const intersectionId = Number(id);

  const [data, setData] = useState<SimulationResponse | null>(null);
  const [timingData, setTimingData] = useState<TimingChunk[]>([]);
  const [typeMix, setTypeMix] = useState<Record<string, TypeFractions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(true);
  const [showAfter, setShowAfter] = useState(true);

  useEffect(() => {
    if (!intersectionId) return;
    setLoading(true);

    // Last complete hour window for aggregation
    const now = new Date();
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const start = new Date(end.getTime() - 3600 * 1000);

    Promise.all([
      simulationApi.get(intersectionId),
      timingApi.list(intersectionId).catch(() => [] as TimingChunk[]),
      aggregationApi.history({
        start: start.toISOString(),
        end: end.toISOString(),
        intersection_id: intersectionId,
        bucket: 'hour',
      }).catch(() => []),
    ])
      .then(([sim, tim, agg]) => {
        setData(sim);
        setTimingData(tim);
        if (sim.chunks.length > 0) {
          // Pick the highest-volume chunk so the chart shows real queue data by default
          const peak = [...sim.chunks].sort((a, b) => b.volume_pcu_hr - a.volume_pcu_hr)[0];
          setSelectedChunk(peak.chunk_name);
        }
        setTypeMix(buildTypeMix(agg));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [intersectionId]);

  const activeChunk   = data?.chunks.find(c => c.chunk_name === selectedChunk) ?? null;
  const activeTiming  = timingData.find(t => t.chunk_name === selectedChunk) ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3 print:hidden">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {data ? data.intersection_name : 'Signal Timing'}
          </h1>
          {data && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Analytical delay simulation · {data.signal_status.replace('_', ' ')}
            </p>
          )}
        </div>
        {data && (
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="size-3.5 mr-1.5" />
            Print / Export PDF
          </Button>
        )}
      </div>

      {/* Print header — only visible when printing */}
      <div className="hidden print:block mb-4">
        <h1 className="text-lg font-bold">{data?.intersection_name} — Signal Timing Report</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Generated {new Date().toLocaleString()} · Webster's formula · {data?.signal_status.replace('_', ' ')}
        </p>
      </div>

      {loading && <Skeleton className="h-64" />}

      {error && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-rose-600">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Before-state source banner */}
          {data.baseline_note && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300">
              {data.baseline_note}
            </div>
          )}

          {/* Warning: signalized but no existing timing entered — before-state is fictional */}
          {(data.signal_status === 'fixed_time' || data.signal_status === 'actuated') && !data.existing_cycle_s && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
              <span className="font-semibold">Before-state is an assumption, not measured data.</span>{' '}
              This intersection is marked as {data.signal_status.replace('_', '-')} but no existing cycle length
              or green splits have been entered. The "before" delay is computed using an equal-split default
              and will understate or overstate the real improvement.{' '}
              <span className="font-medium">
                Go to Intersections → Signal Timing and enter the current cycle length and per-approach splits
                to get an accurate comparison.
              </span>
            </div>
          )}

          {/* LOS data missing — analysis predates the upgrade, will self-heal on next scheduled run */}
          {data.chunks.some(c => c.vc_ratio_before == null) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300">
              LOS grades and v/c ratios are not yet available for this intersection —
              they will appear automatically after the next scheduled analysis (within the hour).
            </div>
          )}

          {/* Daily summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Avg delay before</p>
              <p className="text-xl font-semibold mt-1">{fmt(data.daily_summary.avg_delay_before)}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <p className="text-xs text-muted-foreground">per vehicle</p>
                <LosBadge grade={data.daily_summary.los_before} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Avg delay after</p>
              <p className="text-xl font-semibold mt-1 text-emerald-600">{fmt(data.daily_summary.avg_delay_after)}</p>
              <div className="flex items-center gap-1.5 mt-1">
                <p className="text-xs text-muted-foreground">per vehicle</p>
                <LosBadge grade={data.daily_summary.los_after} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Vehicle-hours saved</p>
              <p className={cn('text-xl font-semibold mt-1', data.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                {data.daily_summary.total_vehicle_hours_saved.toFixed(1)} vh
              </p>
              <p className="text-xs text-muted-foreground mt-1">per day</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Total flow</p>
              <p className="text-xl font-semibold mt-1">{data.daily_summary.total_volume_pcu_hr.toFixed(0)} PCU</p>
              <p className="text-xs text-muted-foreground mt-1">across all chunks</p>
            </div>
          </div>

          {/* Per-chunk table */}
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chunk</TableHead>
                  <TableHead className="text-right">Delay before</TableHead>
                  <TableHead className="text-center">LOS</TableHead>
                  <TableHead className="text-right">Delay after</TableHead>
                  <TableHead className="text-center">LOS</TableHead>
                  <TableHead className="text-right">v/c (worst)</TableHead>
                  <TableHead className="text-right">Improvement</TableHead>
                  <TableHead className="text-right">Flow (PCU/hr)</TableHead>
                  <TableHead className="text-right">Veh-hrs saved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.chunks.map(chunk => {
                  const improvement = chunk.delay_before - chunk.delay_after;
                  const pct = chunk.delay_before > 0
                    ? Math.round((improvement / chunk.delay_before) * 100)
                    : 0;
                  return (
                    <TableRow
                      key={chunk.chunk_name}
                      className={cn(
                        'cursor-pointer',
                        selectedChunk === chunk.chunk_name && 'bg-muted/50',
                      )}
                      onClick={() => setSelectedChunk(chunk.chunk_name)}
                    >
                      <TableCell className="font-medium">{chunk.chunk_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(chunk.delay_before)}</TableCell>
                      <TableCell className="text-center"><LosBadge grade={chunk.los_before} /></TableCell>
                      <TableCell className={cn('text-right tabular-nums', deltaClass(chunk.delay_before, chunk.delay_after))}>
                        {fmt(chunk.delay_after)}
                      </TableCell>
                      <TableCell className="text-center"><LosBadge grade={chunk.los_after} /></TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {chunk.vc_ratio_before != null
                          ? `${fmtVc(chunk.vc_ratio_before)} → ${fmtVc(chunk.vc_ratio_after)}`
                          : '—'}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', improvement > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        {improvement > 0 ? `−${improvement.toFixed(1)}s (${pct}%)` : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{chunk.volume_pcu_hr.toFixed(0)}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', chunk.vehicle_hours_saved > 0 && 'text-emerald-600')}>
                        {chunk.vehicle_hours_saved > 0 ? chunk.vehicle_hours_saved.toFixed(2) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {/* Daily summary row */}
                <TableRow className="bg-muted/30 font-semibold border-t-2 border-border">
                  <TableCell>Daily total</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(data.daily_summary.avg_delay_before)}</TableCell>
                  <TableCell className="text-center"><LosBadge grade={data.daily_summary.los_before} /></TableCell>
                  <TableCell className={cn('text-right tabular-nums', deltaClass(data.daily_summary.avg_delay_before, data.daily_summary.avg_delay_after))}>
                    {fmt(data.daily_summary.avg_delay_after)}
                  </TableCell>
                  <TableCell className="text-center"><LosBadge grade={data.daily_summary.los_after} /></TableCell>
                  <TableCell className="text-right text-muted-foreground">—</TableCell>
                  <TableCell className="text-right text-muted-foreground">avg</TableCell>
                  <TableCell className="text-right tabular-nums">{data.daily_summary.total_volume_pcu_hr.toFixed(0)}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', data.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                    {data.daily_summary.total_vehicle_hours_saved.toFixed(2)} vh
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Queue time-series chart */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold">Queue length — {activeChunk.chunk_name}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Vehicles queued per approach over a simulated 60-minute window</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={showBefore ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => setShowBefore(v => !v)}
                  >
                    Before
                  </Button>
                  <Button
                    size="sm"
                    variant={showAfter ? 'default' : 'outline'}
                    className="h-7 text-xs"
                    onClick={() => setShowAfter(v => !v)}
                  >
                    After
                  </Button>
                </div>
              </div>

              {/* Chunk selector tabs */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {data.chunks.map(c => (
                  <button
                    key={c.chunk_name}
                    onClick={() => setSelectedChunk(c.chunk_name)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md border transition-colors',
                      selectedChunk === c.chunk_name
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
                    )}
                  >
                    {c.chunk_name}
                  </button>
                ))}
              </div>

              <ChunkQueueChart chunk={activeChunk} showBefore={showBefore} showAfter={showAfter} />

              <p className="text-xs text-muted-foreground mt-2">
                Dashed lines = before timing · Solid lines = proposed timing · Each color = one approach
              </p>
            </div>
          )}

          {/* 2D canvas intersection simulation */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="mb-4">
                <h2 className="text-sm font-semibold">
                  Intersection simulation — {activeChunk.chunk_name}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Top-down canvas · queue bars grow during red, clear on green · 60-minute window
                </p>
              </div>
              <DualIntersectionCanvas
                chunk={activeChunk}
                timing={activeTiming}
                signalStatus={data.signal_status}
                typeMix={typeMix}
              />
            </div>
          )}

          {/* Calculation basis */}
          {activeTiming && (
            <div className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-semibold mb-3">Calculation basis — {activeTiming.chunk_name}</h2>

              {activeTiming.assumptions && (
                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Webster's formula parameters</div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {Object.entries(activeTiming.assumptions).map(([k, v]) => (
                      <div key={k} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-center">
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wide leading-tight">
                          {k.replace(/_/g, ' ')}
                        </div>
                        <div className="text-xs font-semibold mt-0.5">{String(v)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTiming.measured_flows && Object.keys(activeTiming.measured_flows).length > 0 ? (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                    Observed approach flows — 7-day average (PCU/hr)
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(activeTiming.measured_flows).map(([sid, flow], idx) => (
                      <div key={sid} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-center">
                        <div
                          className="text-[9px] uppercase tracking-wide leading-tight"
                          style={{ color: APPROACH_COLORS[idx % APPROACH_COLORS.length] }}
                        >
                          Approach {sid}
                        </div>
                        <div className="text-xs font-semibold mt-0.5">{flow} PCU/hr</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No observed flow data for this chunk — timing uses minimum cycle length ({activeTiming.cycle_length}s).
                </p>
              )}
            </div>
          )}

          {data.chunks.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <TrendingDown className="size-10 opacity-30" />
              <p className="text-sm">No simulation data — regenerate the recommendation to compute delay estimates.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
