import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { simulationApi, type SimulationChunk, type SimulationResponse } from '@/services/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import { aggregationApi } from '@/services/aggregation';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { DualIntersectionCanvas, type VehicleType, type TypeFractions } from '@/components/IntersectionCanvas';
import { IntersectionSignal3D } from '@/components/TrafficSignal3D';
import { IntersectionScene3D } from '@/components/IntersectionScene3D';
import type { AggregationRow, Street, Intersection } from '@/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ArrowLeft, TrendingDown, Printer, Play, Pause, Columns2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const APPROACH_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

const ARM_SHORT: Record<string, string> = {
  northbound: 'N', southbound: 'S', eastbound: 'E', westbound: 'W', unknown: '?',
};

const YELLOW_S = 3;

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

function ChunkQueueChart({ chunk }: { chunk: SimulationChunk }) {
  const before = chunk.queue_series_before ?? {};
  const after  = chunk.queue_series_after  ?? {};
  const len = Math.max(
    ...Object.values(before).map(s => s.length),
    ...Object.values(after).map(s => s.length),
    0,
  );
  if (len === 0) return <p className="text-xs text-muted-foreground py-4 text-center">No queue data</p>;

  const data = Array.from({ length: len }, (_, i) => ({
    minute: i + 1,
    current: Object.values(before).reduce((s, arr) => s + (arr[i] ?? 0), 0),
    webster: Object.values(after).reduce((s, arr)  => s + (arr[i] ?? 0), 0),
  }));

  return (
    <>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="minute" tick={{ fontSize: 11 }} tickFormatter={v => `${v}m`} />
          <YAxis tick={{ fontSize: 11 }} width={32} />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(v, name) => [`${Number(v).toFixed(1)} veh`, name === 'current' ? 'Current timing' : 'Webster timing']}
          />
          <Line type="monotone" dataKey="current" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          <Line type="monotone" dataKey="webster" stroke="#10b981" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block w-5 border-t-2 border-dashed border-[#94a3b8]" />
          Current timing (total queue)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block w-5 border-t-2 border-[#10b981]" />
          Webster timing (total queue)
        </span>
      </div>
    </>
  );
}

function GanttBar({ label, greenSec, cycleLength }: { label: string; greenSec: number; cycleLength: number }) {
  const redSec = Math.max(0, cycleLength - greenSec - YELLOW_S);
  const greenPct = (greenSec / cycleLength) * 100;
  const yellowPct = (YELLOW_S / cycleLength) * 100;
  const redPct = (redSec / cycleLength) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-24 shrink-0 truncate" title={label}>{label}</span>
      <div className="flex flex-1 rounded overflow-hidden h-5">
        <div
          style={{ width: `${greenPct}%` }}
          className="bg-emerald-500 flex items-center justify-center text-[10px] text-white font-medium"
          title={`Green: ${greenSec.toFixed(0)}s`}
        >
          {greenPct > 10 ? `${greenSec.toFixed(0)}s` : ''}
        </div>
        <div
          style={{ width: `${yellowPct}%` }}
          className="bg-amber-400"
          title={`Yellow: ${YELLOW_S}s`}
        />
        <div
          style={{ width: `${redPct}%` }}
          className="bg-rose-400/40 flex items-center justify-center text-[10px] text-rose-700 dark:text-rose-300"
          title={`Red: ${redSec.toFixed(0)}s`}
        >
          {redPct > 15 ? `${redSec.toFixed(0)}s` : ''}
        </div>
      </div>
    </div>
  );
}

function GanttDiagram({
  title,
  cycleLength,
  approaches,
  titleClassName,
}: {
  title: string;
  cycleLength: number;
  approaches: { label: string; greenSec: number }[];
  titleClassName?: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <p className={cn('text-xs font-semibold text-center', titleClassName ?? 'text-foreground')}>{title}</p>
      <p className="text-[10px] text-muted-foreground text-center mb-3">{cycleLength}s cycle</p>
      <div className="space-y-2">
        {approaches.map(a => <GanttBar key={a.label} {...a} cycleLength={cycleLength} />)}
      </div>
    </div>
  );
}

export function SignalTimingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const intersectionId = Number(id);

  const [data, setData] = useState<SimulationResponse | null>(null);
  const [timingData, setTimingData] = useState<TimingChunk[]>([]);
  const [streets, setStreets] = useState<Street[]>([]);
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [typeMix, setTypeMix] = useState<Record<string, TypeFractions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  const [view3D, setView3D] = useState(false);
  const [show3DBefore, setShow3DBefore] = useState(false);
  const [sbs3D, setSbs3D] = useState(false);
  const [paused3D, setPaused3D] = useState(false);
  const [speed3D, setSpeed3D] = useState<1 | 2 | 4>(1);

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
      streetsApi.list().catch(() => [] as Street[]),
      intersectionsApi.get(intersectionId).catch(() => null),
    ])
      .then(([sim, tim, agg, allStreets, inter]) => {
        setData(sim);
        setTimingData(tim);
        setStreets(allStreets.filter(s => s.intersection_id === intersectionId));
        setIntersection(inter);
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

          {/* Per-chunk table — click a row to select it for the chart / simulation */}
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Before delay</TableHead>
                  <TableHead className="text-right">After delay</TableHead>
                  <TableHead className="text-right">Improvement</TableHead>
                  <TableHead className="text-right">Veh-hrs saved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.chunks.map(chunk => {
                  const improvement = chunk.delay_before - chunk.delay_after;
                  const pct = chunk.delay_before > 0 ? Math.round((improvement / chunk.delay_before) * 100) : 0;
                  return (
                    <TableRow
                      key={chunk.chunk_name}
                      className={cn('cursor-pointer', selectedChunk === chunk.chunk_name && 'bg-muted/50')}
                      onClick={() => setSelectedChunk(chunk.chunk_name)}
                    >
                      <TableCell className="font-medium">{chunk.chunk_name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="mr-1.5">{fmt(chunk.delay_before)}</span>
                        <LosBadge grade={chunk.los_before} />
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', deltaClass(chunk.delay_before, chunk.delay_after))}>
                        <span className="mr-1.5">{fmt(chunk.delay_after)}</span>
                        <LosBadge grade={chunk.los_after} />
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', improvement > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        {improvement > 0 ? `−${improvement.toFixed(1)}s (${pct}%)` : '—'}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', chunk.vehicle_hours_saved > 0 && 'text-emerald-600')}>
                        {chunk.vehicle_hours_saved > 0 ? `${chunk.vehicle_hours_saved.toFixed(2)} vh` : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/30 font-semibold border-t-2 border-border">
                  <TableCell>Daily avg</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="mr-1.5">{fmt(data.daily_summary.avg_delay_before)}</span>
                    <LosBadge grade={data.daily_summary.los_before} />
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums', deltaClass(data.daily_summary.avg_delay_before, data.daily_summary.avg_delay_after))}>
                    <span className="mr-1.5">{fmt(data.daily_summary.avg_delay_after)}</span>
                    <LosBadge grade={data.daily_summary.los_after} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">avg</TableCell>
                  <TableCell className={cn('text-right tabular-nums', data.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                    {data.daily_summary.total_vehicle_hours_saved.toFixed(2)} vh
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Phase comparison — Current vs Recommended */}
          {activeTiming && streets.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-5 print:break-inside-avoid">
              <h2 className="text-sm font-semibold mb-4">Phase comparison — {activeTiming.chunk_name}</h2>
              <div className="flex gap-6 flex-col sm:flex-row">
                {intersection?.existing_cycle_length && intersection?.existing_green_splits ? (
                  <GanttDiagram
                    title="Current timing"
                    cycleLength={intersection.existing_cycle_length}
                    approaches={streets
                      .filter(s => s.arm_direction !== 'unknown')
                      .map(s => ({
                        label: `${ARM_SHORT[s.arm_direction] ?? '?'} — ${s.name}`,
                        greenSec: (intersection.existing_green_splits as Record<string, number>)[s.arm_direction] ?? 0,
                      }))}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center py-8 rounded-md border border-dashed border-border text-xs text-muted-foreground text-center px-4">
                    No current timing entered.{' '}
                    <span className="font-medium">Use the wizard to add your existing cycle length and splits.</span>
                  </div>
                )}
                <div className="w-px bg-border hidden sm:block shrink-0" />
                <GanttDiagram
                  title="Recommended (Webster)"
                  cycleLength={activeTiming.cycle_length}
                  approaches={streets
                    .filter(s => s.arm_direction !== 'unknown')
                    .map(s => ({
                      label: `${ARM_SHORT[s.arm_direction] ?? '?'} — ${s.name}`,
                      greenSec: activeTiming.green_splits[String(s.id)] ?? 0,
                    }))}
                  titleClassName="text-emerald-600"
                />
              </div>
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-emerald-500" /> Green
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-amber-400" /> Yellow (3s)
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2.5 rounded-sm bg-rose-400/40" /> Red
                </span>
              </div>
            </div>
          )}

          {/* Queue time-series chart */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold">Total queue — {activeChunk.chunk_name}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Combined vehicles queued across all approaches · 60-min simulation</p>
                </div>
                {/* Chunk selector tabs */}
                <div className="flex flex-wrap gap-1 shrink-0">
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
              </div>
              <ChunkQueueChart chunk={activeChunk} />
            </div>
          )}

          {/* Intersection simulation — 2D / 3D toggle */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold">
                    Intersection simulation — {activeChunk.chunk_name}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {view3D ? 'drag to orbit · scroll to zoom' : 'top-down · queue bars grow on red, clear on green'}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* 2D / 3D */}
                  <div className="flex rounded-md border border-border overflow-hidden">
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors', !view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(false)}>2D</button>
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(true)}>3D</button>
                  </div>

                  {view3D && (
                    <>
                      {/* Side-by-side */}
                      <button
                        title="Side by side"
                        onClick={() => setSbs3D(v => !v)}
                        className={cn('flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors',
                          sbs3D ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted')}
                      >
                        <Columns2 className="size-3" />
                        Side by side
                      </button>

                      {/* Before / After — only when not SBS */}
                      {!sbs3D && (
                        <div className="flex rounded-md border border-border overflow-hidden">
                          <button className={cn('px-3 py-1 text-xs font-medium transition-colors', show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(true)}>Before</button>
                          <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', !show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(false)}>After</button>
                        </div>
                      )}

                      {/* Play / Pause */}
                      <button
                        onClick={() => setPaused3D(v => !v)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
                        title={paused3D ? 'Resume' : 'Pause'}
                      >
                        {paused3D ? <Play className="size-3" /> : <Pause className="size-3" />}
                        {paused3D ? 'Play' : 'Pause'}
                      </button>

                      {/* Speed */}
                      <div className="flex rounded-md border border-border overflow-hidden">
                        {([1, 2, 4] as const).map(s => (
                          <button
                            key={s}
                            onClick={() => setSpeed3D(s)}
                            className={cn('px-2.5 py-1 text-xs font-medium transition-colors border-l first:border-l-0 border-border',
                              speed3D === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                          >
                            {s}×
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {!view3D && (
                <DualIntersectionCanvas
                  chunk={activeChunk}
                  timing={activeTiming}
                  signalStatus={data.signal_status}
                  typeMix={typeMix}
                />
              )}

              {view3D && activeTiming && !sbs3D && (
                <IntersectionScene3D
                  timing={activeTiming}
                  streets={streets}
                  signalOff={activeTiming.signal_off}
                  volumePcuHr={activeChunk.volume_pcu_hr}
                  typeMix={typeMix}
                  showBefore={show3DBefore}
                  signalStatus={data.signal_status}
                  existingCycleS={intersection?.existing_cycle_length ?? null}
                  existingGreenSplits={intersection?.existing_green_splits ?? null}
                  paused={paused3D}
                  speed={speed3D}
                />
              )}

              {view3D && activeTiming && sbs3D && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground text-center mb-1.5">Current timing (before)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={activeChunk.volume_pcu_hr}
                      typeMix={typeMix}
                      showBefore={true}
                      signalStatus={data.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                    />
                  </div>
                  <div>
                    <p className="text-xs text-emerald-600 text-center mb-1.5">Webster timing (after)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={activeChunk.volume_pcu_hr}
                      typeMix={typeMix}
                      showBefore={false}
                      signalStatus={data.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                    />
                  </div>
                </div>
              )}

              {view3D && !activeTiming && (
                <div className="flex items-center justify-center h-48 text-xs text-muted-foreground">
                  No timing data for this chunk — regenerate recommendation to enable 3D view.
                </div>
              )}
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
