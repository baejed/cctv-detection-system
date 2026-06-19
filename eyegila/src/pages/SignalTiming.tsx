import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { simulationApi, type SimulationChunk, type SimulationResponse } from '@/services/simulation';
import { timingApi, type TimingChunk } from '@/services/timing';
import { aggregationApi } from '@/services/aggregation';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { IntersectionSummary } from '@/components/IntersectionSummary';
import { IntersectionTabs } from '@/components/IntersectionTabs';
import { ARM_SHORT, GanttDiagram, LosBadge } from '@/components/signal-timing-viz';
import { selectPeakChunk } from '@/lib/simulation';
import type { SignalTimingPayload } from '@/services/intersections';
import { DualIntersectionCanvas, type VehicleType, type TypeFractions } from '@/components/IntersectionCanvas';
import { IntersectionScene3D } from '@/components/IntersectionScene3D';
import type { AggregationRow, Street, Intersection } from '@/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, TrendingDown, Printer, Play, Pause, Columns2, MonitorPlay, X, Pencil, History, Loader2, FlaskConical, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

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

function fmt(n: number | null | undefined, unit = 's'): string {
  if (n == null) return '-';
  return `${n.toFixed(1)}${unit}`;
}

function fmtVc(n: number | null | undefined): string {
  if (n == null) return '-';
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


// ── Traffic timeline picker ──────────────────────────────────────────────────

function pad2(n: number) { return String(n).padStart(2, '0'); }

function barGradient(count: number, max: number): string {
  if (count === 0) return 'none';
  const r = count / max;
  if (r < 0.33) return 'linear-gradient(to top, #14532d, #4ade80)';
  if (r < 0.66) return 'linear-gradient(to top, #78350f, #fbbf24)';
  if (r < 0.85) return 'linear-gradient(to top, #7c2d12, #fb923c)';
  return                'linear-gradient(to top, #7f1d1d, #f87171)';
}

interface TrafficTimelineProps {
  intersectionId: number;
  onRange: (start: string, end: string, vph: number) => void;
}

function TrafficTimeline({ intersectionId, onRange }: TrafficTimelineProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]           = useState(today);
  const [bars, setBars]           = useState<{ hour: number; count: number }[]>([]);
  const [tlLoading, setTlLoading] = useState(false);
  const [selA, setSelA]           = useState<number | null>(null);
  const [selB, setSelB]           = useState<number | null>(null);
  const [anchor, setAnchor]       = useState<number | null>(null);
  const [dragging, setDragging]   = useState(false);
  const [hovered, setHovered]     = useState<number | null>(null);
  const containerRef              = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTlLoading(true);
    const next = new Date(date + 'T12:00:00');
    next.setDate(next.getDate() + 1);
    const end = next.toISOString().slice(0, 10) + 'T00:00:00';
    aggregationApi.history({ start: date + 'T00:00:00', end, intersection_id: intersectionId, bucket: 'hour' })
      .then(rows => {
        const byHour: Record<number, number> = {};
        for (const r of rows) {
          if (r.object_type === 'pedestrian' || r.object_type === 'person') continue;
          const h = new Date(r.window_start).getHours();
          byHour[h] = (byHour[h] ?? 0) + r.count;
        }
        setBars(Array.from({ length: 24 }, (_, h) => ({ hour: h, count: byHour[h] ?? 0 })));
      })
      .catch(() => setBars(Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }))))
      .finally(() => setTlLoading(false));
  }, [date, intersectionId]);

  function shiftDate(days: number) {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const s = d.toISOString().slice(0, 10);
    if (s > today) return;
    setDate(s); setSelA(null); setSelB(null);
  }

  function hourFromClientX(x: number): number {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(23, Math.floor(((x - rect.left) / rect.width) * 24)));
  }

  function applySelection(a: number, b: number) {
    const h1 = Math.min(a, b);
    const h2 = Math.max(a, b);
    setSelA(h1); setSelB(h2);
    // When h2 = 23 the end hour wraps to midnight of the NEXT calendar day.
    // T24:00 is technically ISO 8601 but the JS Date() constructor handles it
    // inconsistently across engines, so we always stay within HH 00–23.
    let endStr: string;
    if (h2 + 1 < 24) {
      endStr = `${date}T${pad2(h2 + 1)}:00`;
    } else {
      // Advance date by 1 using T12:00:00 to stay in local-noon, safely clear of DST boundaries.
      const next = new Date(date + 'T12:00:00');
      next.setDate(next.getDate() + 1);
      endStr = next.toISOString().slice(0, 10) + 'T00:00';
    }
    const total = bars.slice(h1, h2 + 1).reduce((s, b) => s + b.count, 0);
    const hours = h2 - h1 + 1;
    const vph = hours > 0 ? total / hours : 0;
    onRange(`${date}T${pad2(h1)}:00`, endStr, vph);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = hourFromClientX(e.clientX);
    setAnchor(h); setSelA(h); setSelB(h); setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const h = hourFromClientX(e.clientX);
    setHovered(h);
    if (dragging && anchor !== null) { setSelA(Math.min(anchor, h)); setSelB(Math.max(anchor, h)); }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (anchor !== null) {
      const h = hourFromClientX(e.clientX);
      applySelection(anchor, h);
    }
    setDragging(false);
  }

  const maxCount = Math.max(1, ...bars.map(b => b.count));
  const peakHour = bars.reduce((best, b) => b.count > (bars[best]?.count ?? 0) ? b.hour : best, 0);
  const selCount = selA !== null && selB !== null
    ? bars.slice(selA, selB + 1).reduce((s, b) => s + b.count, 0)
    : 0;

  function selectPreset(h1: number, h2: number) { applySelection(h1, h2 - 1); }
  function selectPeakHour() {
    const a = Math.max(0, peakHour - 1);
    const b = Math.min(23, peakHour + 1);
    applySelection(a, b);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Controls row */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shiftDate(-1)}
            className="size-7 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted transition-colors text-base leading-none">
            ‹
          </button>
          <input type="date" value={date} max={today}
            onChange={e => { setDate(e.target.value); setSelA(null); setSelB(null); }}
            className="h-7 text-xs px-2 rounded border border-input bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button type="button" onClick={() => shiftDate(1)} disabled={date >= today}
            className="size-7 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted transition-colors text-base leading-none disabled:opacity-30">
            ›
          </button>
        </div>

        <div className="flex gap-1 flex-wrap">
          <button type="button" onClick={selectPeakHour}
            className="h-6 px-2 text-[10px] rounded border border-amber-400/50 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors font-medium">
            ▲ Peak
          </button>
          {([['AM', 6, 12], ['PM', 12, 19], ['Full day', 6, 20]] as const).map(([label, h1, h2]) => (
            <button key={label} type="button" onClick={() => selectPreset(h1, h2)}
              className="h-6 px-2 text-[10px] rounded border border-border text-muted-foreground hover:bg-muted transition-colors">
              {label}
            </button>
          ))}
        </div>

        {tlLoading && <span className="text-[10px] text-muted-foreground animate-pulse ml-auto">loading…</span>}
      </div>

      {/* Waveform */}
      <div
        ref={containerRef}
        className="relative rounded-lg overflow-hidden border border-border select-none"
        style={{ height: 130, background: '#070d19', cursor: dragging ? 'col-resize' : 'crosshair', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setDragging(false); setHovered(null); }}
      >
        {/* Subtle grid lines at 6h */}
        {[6, 12, 18].map(h => (
          <div key={h} className="absolute top-0 bottom-6 w-px bg-white/[0.04]"
            style={{ left: `${(h / 24) * 100}%` }} />
        ))}

        {/* Selection overlay + handles */}
        {selA !== null && selB !== null && (
          <>
            <div className="absolute top-0 bottom-6 bg-teal-400/[0.08] pointer-events-none"
              style={{ left: `${(selA / 24) * 100}%`, width: `${((selB - selA + 1) / 24) * 100}%` }} />
            <div className="absolute top-0 bottom-6 w-0.5 bg-teal-400/80 pointer-events-none"
              style={{ left: `${(selA / 24) * 100}%` }} />
            <div className="absolute top-0 bottom-6 w-0.5 bg-teal-400/80 pointer-events-none"
              style={{ left: `${((selB + 1) / 24) * 100}%` }} />
            {/* Handle tabs */}
            <div className="absolute top-2 w-1 h-6 rounded-sm bg-teal-400 pointer-events-none"
              style={{ left: `calc(${(selA / 24) * 100}% - 2px)` }} />
            <div className="absolute top-2 w-1 h-6 rounded-sm bg-teal-400 pointer-events-none"
              style={{ left: `calc(${((selB + 1) / 24) * 100}% + 1px)` }} />
          </>
        )}

        {/* Bars */}
        <div className="absolute inset-x-0 bottom-6 top-0 flex items-end" style={{ gap: '1.5px', padding: '0 1.5px' }}>
          {bars.map(b => {
            const inSel = selA !== null && selB !== null && b.hour >= selA && b.hour <= selB;
            const isHov = hovered === b.hour;
            const isPeak = b.hour === peakHour && b.count > 0;
            const heightPct = Math.max(2, (b.count / maxCount) * 88);
            return (
              <div
                key={b.hour}
                className="flex-1 rounded-t transition-all duration-75"
                style={{
                  height: `${heightPct}%`,
                  background: b.count === 0
                    ? '#111827'
                    : inSel
                      ? 'linear-gradient(to top, #0d9488, #5eead4)'
                      : isHov || isPeak
                        ? 'linear-gradient(to top, #3730a3, #a5b4fc)'
                        : barGradient(b.count, maxCount),
                  opacity: b.count === 0 ? 0.25 : 1,
                  boxShadow: inSel ? '0 0 6px #14b8a640' : isPeak ? '0 0 8px #818cf860' : 'none',
                }}
              />
            );
          })}
        </div>

        {/* Peak label */}
        {bars[peakHour]?.count > 0 && (
          <div className="absolute bottom-6 pointer-events-none flex flex-col items-center"
            style={{ left: `${((peakHour + 0.5) / 24) * 100}%`, transform: 'translateX(-50%)' }}>
            <span className="text-[7px] font-bold text-indigo-400/70 leading-none">▲</span>
          </div>
        )}

        {/* Hover crosshair */}
        {hovered !== null && (
          <div className="absolute top-0 bottom-6 w-px bg-white/10 pointer-events-none"
            style={{ left: `${((hovered + 0.5) / 24) * 100}%` }} />
        )}

        {/* Hover tooltip */}
        {hovered !== null && bars[hovered]?.count > 0 && (
          <div
            className="absolute top-2 pointer-events-none z-10"
            style={{ left: `${Math.min(Math.max(((hovered + 0.5) / 24) * 100, 5), 78)}%`, transform: 'translateX(-50%)' }}
          >
            <div className="bg-slate-900/95 border border-white/10 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap shadow-lg">
              <span className="font-mono font-semibold">{pad2(hovered)}:00</span>
              <span className="text-white/50 mx-1">·</span>
              <span className="text-white/80">{bars[hovered].count.toLocaleString()} veh</span>
            </div>
          </div>
        )}

        {/* Hour axis */}
        <div className="absolute inset-x-0 bottom-0 h-6 flex items-center">
          {[0, 3, 6, 9, 12, 15, 18, 21].map(h => (
            <div key={h} className="absolute text-[8px] text-white/20 font-mono"
              style={{ left: `${(h / 24) * 100}%`, transform: 'translateX(-50%)' }}>
              {pad2(h)}
            </div>
          ))}
        </div>
      </div>

      {/* Selection summary / hint */}
      {selA !== null && selB !== null ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono font-semibold text-teal-600 dark:text-teal-400">
            {pad2(selA)}:00 – {pad2(Math.min(selB + 1, 24))}:00
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{selCount.toLocaleString()} vehicles detected</span>
          {selB > selA && (
            <><span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{selB - selA + 1}h window</span></>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Drag to select a range · click a bar for a single hour · color = traffic density
        </p>
      )}
    </div>
  );
}

export function SignalTimingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const intersectionId = Number(id);

  const [data, setData] = useState<SimulationResponse | null>(null);
  const [timingData, setTimingData] = useState<TimingChunk[]>([]);
  const [streets, setStreets] = useState<Street[]>([]);
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [rec, setRec] = useState<RecommendationResponse | null>(null);
  const [typeMix, setTypeMix] = useState<Record<string, TypeFractions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  const [view3D, setView3D] = useState(false);
  const [show3DBefore, setShow3DBefore] = useState(false);
  const [sbs3D, setSbs3D] = useState(false);
  const [paused3D, setPaused3D] = useState(false);
  const [speed3D, setSpeed3D] = useState<1 | 2 | 4>(1);
  const [presentMode, setPresentMode] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editStatus, setEditStatus] = useState<string>('fixed_time');
  const [editCycle, setEditCycle] = useState('');
  const [editSplits, setEditSplits] = useState<Record<number, string>>({});

  // Historical window analysis
  const [histStart, setHistStart] = useState('');
  const [histEnd, setHistEnd]     = useState('');
  const [histData, setHistData]   = useState<SimulationResponse | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const [histMode, setHistMode]   = useState(false);
  // Bar-chart-derived rate fed to the 3D scene while in histMode.
  // Raw count over the selected window divided by hour span (no PCE).
  const [histVph, setHistVph]     = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPresentMode(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const loadAll = useCallback(async () => {
    if (!intersectionId) return;
    setLoading(true);

    // Last complete hour window for aggregation
    const now = new Date();
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const start = new Date(end.getTime() - 3600 * 1000);

    try {
      const [sim, tim, agg, allStreets, inter, latestRec] = await Promise.all([
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
        recommendationsApi.latest(intersectionId).catch(() => null),
      ]);
      setData(sim);
      setTimingData(tim);
      setStreets(allStreets.filter(s => s.intersection_id === intersectionId));
      setIntersection(inter);
      setRec(latestRec);
      setTypeMix(buildTypeMix(agg));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [intersectionId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Deep-link from a Fix button (e.g. /intersections/:id/timing?edit=1) opens
  // the edit-timing modal as soon as the intersection has loaded, then strips
  // the param so a manual refresh doesn't keep re-opening it.
  useEffect(() => {
    if (!intersection) return;
    if (searchParams.get('edit') !== '1') return;
    openEdit();
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intersection, searchParams]);

  const [generating, setGenerating] = useState(false);
  async function runAnalyse() {
    if (!intersectionId) return;
    setGenerating(true);
    try {
      await recommendationsApi.generate(intersectionId);
      toast.success('Analysis complete');
      await loadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  // When in historical mode, drive all visuals from histData; fall back to saved simulation
  const displayData = histMode && histData ? histData : data;

  // null selectedChunk = "All" (aggregate view); specific name = per-chunk view
  const displayChunk = selectedChunk
    ? (displayData?.chunks.find(c => c.chunk_name === selectedChunk) ?? null)
    : null;

  // For charts that require a single chunk (queue, simulation, Gantt),
  // fall back to the highest-volume chunk when "All" is selected.
  const peakChunk = selectPeakChunk(displayData);
  const activeChunk = displayChunk ?? peakChunk;
  // As soon as the user picks a range on the bar chart, that rate feeds the 3D
  // visual - no need to wait for the Analyse button. Visual-only: analytical
  // numbers still come from the server-side compute. Raw veh/hr (no PCE) is
  // intentional - the scene is illustrative, not analytical, so we don't
  // duplicate PCE multipliers client-side.
  const effectiveVolumePcuHr = histVph != null
    ? histVph
    : (activeChunk?.volume_pcu_hr ?? 0);

  // Synthesize a TimingChunk from historical proposed splits so Gantt + 3D still work
  const histTiming = histMode && activeChunk?.proposed_cycle_s != null ? {
    id: -1,
    intersection_id: intersectionId,
    recommendation_id: -1,
    chunk_name: activeChunk.chunk_name,
    cycle_length: activeChunk.proposed_cycle_s!,
    green_splits: activeChunk.proposed_splits ?? {},
    effective_date: '',
    pce_tier_used: 'measured',
    signal_off: false,
    generated_at: activeChunk.generated_at,
    measured_flows: activeChunk.measured_flows ?? null,
    assumptions: null,
  } : null;

  const peakTiming      = peakChunk ? (timingData.find(t => t.chunk_name === peakChunk.chunk_name) ?? null) : null;
  const selectedTiming  = timingData.find(t => t.chunk_name === selectedChunk) ?? null;
  const displayTiming   = histMode ? histTiming : (selectedTiming ?? peakTiming);
  const activeTiming    = displayTiming;

  function openEdit() {
    if (!intersection) return;
    setEditStatus(intersection.signal_status ?? 'fixed_time');
    const cycle = intersection.existing_cycle_length ?? 90;
    setEditCycle(String(cycle));
    const splits: Record<number, string> = {};
    const defaultGreen = Math.round(cycle / Math.max(streets.length, 1));
    for (const s of streets) {
      splits[s.id] = String(
        (intersection.existing_green_splits as Record<string, number> | null)?.[String(s.id)]
        ?? defaultGreen,
      );
    }
    setEditSplits(splits);
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!intersectionId) return;
    setEditSaving(true);
    try {
      const isSignalized = editStatus !== 'unsignalized';
      const cycle = isSignalized ? (parseInt(editCycle) || null) : null;
      const splits: Record<string, number> | null = isSignalized && cycle != null
        ? Object.fromEntries(streets.map(s => [String(s.id), parseInt(editSplits[s.id] ?? '0') || 0]))
        : null;
      const payload: SignalTimingPayload = {
        signal_status: editStatus as SignalTimingPayload['signal_status'],
        existing_cycle_length: cycle,
        existing_green_splits: splits,
      };
      const updated = await intersectionsApi.patchTiming(intersectionId, payload);
      setIntersection(updated);
      setEditOpen(false);
      toast.success('Signal timing updated');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setEditSaving(false);
    }
  }

  async function analyseWindow() {
    if (!histStart || !histEnd) return;
    // histStart / histEnd are naive local-time strings from the bar-chart selector
    // (e.g. '2026-06-16T06:00'). Convert through new Date().toISOString() would
    // shift them by the browser's UTC offset, sending the wrong window to the server.
    // The backend (Asia/Manila) treats naive datetimes as server-local time - the
    // same convention the traffic bar chart already uses for its own history queries.
    const start = histStart + ':00';
    const end   = histEnd   + ':00';
    // String comparison is safe here: both values share the same YYYY-MM-DDTHH:MM:SS format.
    if (end <= start) { toast.error('End must be after start'); return; }
    setHistLoading(true);
    setHistError(null);
    try {
      const result = await simulationApi.compute({ intersection_id: intersectionId, start, end });
      setHistData(result);
      setHistMode(true);
      setSelectedChunk(null);
      toast.success('Historical analysis complete');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'No data for this window';
      setHistError(msg);
      toast.error(msg);
    } finally {
      setHistLoading(false);
    }
  }

  function exitHistMode() {
    setHistMode(false);
    setHistData(null);
    setHistError(null);
    setHistVph(null);
    setSelectedChunk(null);
  }

  return (
    <div className="flex flex-col gap-5 print:gap-2">
      {/* Header */}
      <div className="flex items-center gap-3 print:hidden">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {displayData ? displayData.intersection_name : 'Signal Timing'}
          </h1>
          {displayData && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Analytical delay simulation · {displayData.signal_status.replace('_', ' ')}
              {histMode && <span className="ml-1.5 text-teal-600 dark:text-teal-400">· historical window</span>}
            </p>
          )}
        </div>
        {intersection && !histMode && (
          <Button
            data-testid="btn-analyse-timing"
            variant="ghost"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={runAnalyse}
            disabled={generating}
            title="Run warrant analysis"
          >
            {generating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {generating ? 'Analysing…' : 'Analyse'}
          </Button>
        )}
        {intersection && !histMode && (
          <Button data-testid="btn-edit-timing" variant="outline" size="sm" onClick={openEdit}>
            <Pencil className="size-3.5 mr-1.5" />
            Edit timing
          </Button>
        )}
        {data && (
          <Button data-testid="btn-print" variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="size-3.5 mr-1.5" />
            Print / Export PDF
          </Button>
        )}
        {id && <IntersectionTabs intersectionId={id} />}
      </div>

      {/* Print header - only visible when printing */}
      <div className="hidden print:block mb-4">
        <h1 className="text-lg font-bold">{displayData?.intersection_name} - Signal Timing Report</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Generated {new Date().toLocaleString('en-PH', { timeZoneName: 'short' })} · Webster's formula · {displayData?.signal_status.replace('_', ' ')}
          {histMode && displayData?.window_start ? ` · Window: ${new Date(displayData.window_start).toLocaleString('en-PH')} – ${new Date(displayData.window_end!).toLocaleString('en-PH')}` : ''}
        </p>
      </div>

      {loading && <Skeleton className="h-64" />}

      {error && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-rose-600">
          {error}
        </div>
      )}

      {displayData && !loading && (
        <>
          {/* Before-state source banner */}
          {displayData.baseline_note && (
            <div className={cn(
              'rounded-lg border px-4 py-2.5 text-xs',
              histMode
                ? 'border-teal-300 bg-teal-50 dark:bg-teal-950/20 dark:border-teal-800 text-teal-800 dark:text-teal-300'
                : 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 text-amber-800 dark:text-amber-300',
            )}>
              {displayData.baseline_note}
            </div>
          )}

          {/* Warning: signalized but no existing timing entered - before-state is fictional */}
          {!histMode && (displayData.signal_status === 'fixed_time' || displayData.signal_status === 'actuated') && !displayData.existing_cycle_s && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
              <span className="font-semibold">Before-state is an assumption, not measured data.</span>{' '}
              This intersection is marked as {data.signal_status.replace('_', '-')} but no existing cycle length
              or green splits have been entered. The "before" delay is computed using an equal-split default
              and will understate or overstate the real improvement.{' '}
              <button
                type="button"
                onClick={openEdit}
                className="font-medium underline underline-offset-2 hover:opacity-80 transition-opacity"
              >
                Click "Edit timing" above to enter the current cycle length and per-approach splits.
              </button>
            </div>
          )}

          {/* LOS data missing - analysis predates the upgrade, will self-heal on next scheduled run */}
          {!histMode && displayData.chunks.some(c => c.vc_ratio_before == null) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300">
              LOS grades and v/c ratios are not yet available for this intersection -
              they will appear automatically after the next scheduled analysis (within the hour).
            </div>
          )}

          {/* Analyse a specific window */}
          <div className="rounded-lg border border-border bg-card p-4 print:hidden">
            <div className="flex items-center gap-2 mb-3">
              <History className="size-3.5 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Analyse a specific window</h2>
              {histMode && (
                <span className="ml-auto text-[10px] text-teal-600 dark:text-teal-400 font-medium flex items-center gap-1">
                  <FlaskConical className="size-3" /> Showing real-data window
                </span>
              )}
            </div>

            <TrafficTimeline
              intersectionId={intersectionId}
              onRange={(start, end, vph) => { setHistStart(start); setHistEnd(end); setHistVph(vph); }}
            />

            <div className="flex items-center gap-2 mt-3">
              <Button data-testid="btn-analyse" size="sm" onClick={analyseWindow} disabled={histLoading || !histStart || !histEnd}>
                {histLoading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <FlaskConical className="size-3.5 mr-1.5" />}
                {histLoading ? 'Analysing…' : 'Analyse'}
              </Button>
              {histStart && histEnd && (
                <span className="text-xs text-muted-foreground font-mono">
                  {histStart.slice(0, 10)} · {histStart.slice(11, 16)} – {histEnd.slice(11, 16)}
                </span>
              )}
              {histMode && (
                <Button size="sm" variant="outline" onClick={exitHistMode} className="ml-auto">
                  Back to current
                </Button>
              )}
            </div>
            {histError && <p className="text-xs text-rose-600 mt-2">{histError}</p>}
          </div>

          {/* Verdict card */}
          {(() => {
            const totalVhSaved = displayData.daily_summary.total_vehicle_hours_saved;
            const isUnsignalized = displayData.signal_status === 'unsignalized';
            const positive = totalVhSaved > 0;
            const verdict = isUnsignalized
              ? (positive ? 'Signal installation recommended' : 'No signal warranted')
              : (positive ? 'Re-timing recommended' : 'Current timing near-optimal');
            return (
              <div className={cn(
                'rounded-xl border p-5 flex flex-col gap-1 print:hidden',
                positive
                  ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                  : 'border-border bg-card',
              )}>
                <p className="text-[11px] uppercase tracking-widest font-medium text-muted-foreground">Verdict</p>
                <p className={cn(
                  'text-2xl font-bold leading-tight',
                  positive ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground',
                )}>
                  {verdict}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {positive
                    ? `Webster's optimised timing saves ${totalVhSaved.toFixed(1)} vehicle-hours per day across all periods.`
                    : 'Modelled timing change produces no measurable time saving under current traffic volumes.'}
                </p>
              </div>
            );
          })()}

          {/* Global chunk filter */}
          <div className="flex flex-wrap items-center gap-1.5 print:hidden">
            <button
              data-testid="btn-chunk-all"
              onClick={() => setSelectedChunk(null)}
              className={cn(
                'px-3 py-1 text-xs rounded-md border transition-colors',
                selectedChunk === null
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
              )}
            >
              All periods
            </button>
            {displayData.chunks.map(c => (
              <button
                key={c.chunk_name}
                data-testid={`btn-chunk-${c.chunk_name.toLowerCase().replace(/\s+/g, '-')}`}
                onClick={() => setSelectedChunk(c.chunk_name)}
                className={cn(
                  'px-3 py-1 text-xs rounded-md border transition-colors',
                  selectedChunk === c.chunk_name
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
                )}
              >
                {c.chunk_name}
              </button>
            ))}
          </div>

          {/* Summary strip - shows selected chunk when one is active, daily totals for "All" */}
          {(() => {
            const delayBefore = displayChunk ? displayChunk.delay_before : displayData.daily_summary.avg_delay_before;
            const losBefore   = displayChunk ? displayChunk.los_before   : displayData.daily_summary.los_before;
            const delayAfter  = displayChunk ? displayChunk.delay_after  : displayData.daily_summary.avg_delay_after;
            const losAfter    = displayChunk ? displayChunk.los_after    : displayData.daily_summary.los_after;
            const vhSaved     = displayChunk ? displayChunk.vehicle_hours_saved : displayData.daily_summary.total_vehicle_hours_saved;
            const totalFlow   = displayChunk ? displayChunk.volume_pcu_hr       : displayData.daily_summary.total_volume_pcu_hr;
            const flowLabel   = displayChunk ? 'PCU/hr this period' : (histMode ? 'PCU measured this window' : 'PCU across all periods');
            const vhLabel     = displayChunk ? 'vh saved this period' : (histMode ? 'vh for this window' : 'vh saved per day');
            return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground">Avg delay before</p>
                  <p className="text-xl font-semibold mt-1">{fmt(delayBefore)}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <p className="text-xs text-muted-foreground">per vehicle</p>
                    <LosBadge grade={losBefore} />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground">Avg delay after</p>
                  <p className="text-xl font-semibold mt-1 text-emerald-600">{fmt(delayAfter)}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <p className="text-xs text-muted-foreground">per vehicle</p>
                    <LosBadge grade={losAfter} />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground">Vehicle-hours saved</p>
                  <p className={cn('text-xl font-semibold mt-1', vhSaved > 0 && 'text-emerald-600')}>
                    {vhSaved.toFixed(1)} vh
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{vhLabel}</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 print:p-3">
                  <p className="text-xs text-muted-foreground">Total flow</p>
                  <p className="text-xl font-semibold mt-1">{totalFlow.toFixed(0)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{flowLabel}</p>
                </div>
              </div>
            );
          })()}

          {/* LOS legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground print:hidden">
            <span className="font-medium text-foreground">LOS grade:</span>
            {([
              ['A', '≤10s - free flow'],
              ['B', '10–20s - stable'],
              ['C', '20–35s - acceptable'],
              ['D', '35–55s - approaching unstable'],
              ['E', '55–80s - unstable'],
              ['F', '>80s - forced/breakdown'],
            ] as const).map(([g, desc]) => (
              <span key={g} className="flex items-center gap-1">
                <LosBadge grade={g} /><span>{desc}</span>
              </span>
            ))}
          </div>

          {/* Per-chunk table - click a row to select it for the chart / simulation */}
          <div className="rounded-lg border border-border overflow-hidden print:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Before delay</TableHead>
                  <TableHead className="text-right">After delay</TableHead>
                  <TableHead className="text-right">Improvement</TableHead>
                  <TableHead className="text-right">v/c ratio</TableHead>
                  <TableHead className="text-right">Veh-hrs saved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayData.chunks.map(chunk => {
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
                        {improvement > 0 ? `−${improvement.toFixed(1)}s (${pct}%)` : '-'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {fmtVc(chunk.vc_ratio_before)}
                        {chunk.vc_ratio_before != null && chunk.vc_ratio_after != null && (
                          <span className={cn('ml-1', chunk.vc_ratio_after < chunk.vc_ratio_before ? 'text-emerald-600' : 'text-rose-600')}>
                            → {fmtVc(chunk.vc_ratio_after)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={cn('text-right tabular-nums', chunk.vehicle_hours_saved > 0 && 'text-emerald-600')}>
                        {chunk.vehicle_hours_saved > 0 ? `${chunk.vehicle_hours_saved.toFixed(2)} vh` : '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/30 font-semibold border-t-2 border-border">
                  <TableCell>{histMode ? 'Window total' : 'Daily avg'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="mr-1.5">{fmt(displayData.daily_summary.avg_delay_before)}</span>
                    <LosBadge grade={displayData.daily_summary.los_before} />
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums', deltaClass(displayData.daily_summary.avg_delay_before, displayData.daily_summary.avg_delay_after))}>
                    <span className="mr-1.5">{fmt(displayData.daily_summary.avg_delay_after)}</span>
                    <LosBadge grade={displayData.daily_summary.los_after} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">avg</TableCell>
                  <TableCell className="text-right text-muted-foreground">-</TableCell>
                  <TableCell className={cn('text-right tabular-nums', displayData.daily_summary.total_vehicle_hours_saved > 0 && 'text-emerald-600')}>
                    {displayData.daily_summary.total_vehicle_hours_saved.toFixed(2)} vh
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {/* Phase comparison - Current vs Recommended */}
          {activeTiming && streets.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-5 print:p-3 print:break-inside-avoid">
              <h2 className="text-sm font-semibold mb-4 print:mb-2">Phase comparison - {selectedChunk ? activeTiming.chunk_name : `All periods · using ${activeTiming.chunk_name} (peak)`}</h2>
              <div className="flex gap-6 flex-col sm:flex-row">
                {intersection?.existing_cycle_length && intersection?.existing_green_splits ? (
                  <GanttDiagram
                    title="Current timing"
                    cycleLength={intersection.existing_cycle_length}
                    approaches={streets
                      .filter(s => s.arm_direction !== 'unknown')
                      .map(s => ({
                        label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
                        greenSec: (intersection.existing_green_splits as Record<string, number>)[String(s.id)] ?? 0,
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
                      label: `${ARM_SHORT[s.arm_direction] ?? '?'} - ${s.name}`,
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
              <div className="mb-3">
                <h2 className="text-sm font-semibold">
                  Total queue - {selectedChunk ? activeChunk.chunk_name : 'All periods'}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Combined vehicles queued across all approaches · 60-min simulation
                  {!selectedChunk && <span className="ml-1 text-muted-foreground/60">· using {activeChunk.chunk_name} (peak)</span>}
                </p>
              </div>
              <ChunkQueueChart chunk={activeChunk} />
            </div>
          )}

          {/* Intersection simulation - 2D / 3D toggle */}
          {activeChunk && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold">
                    Intersection simulation - {selectedChunk ? activeChunk.chunk_name : 'All periods'}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {view3D ? 'drag to orbit · scroll to zoom' : 'top-down · queue bars grow on red, clear on green'}
                  </p>
                  {histVph != null && view3D && (
                    <p className="text-[11px] text-teal-600 dark:text-teal-400 mt-1 font-medium">
                      Visual rate: {Math.round(histVph)} veh/hr · selected range
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* 2D / 3D */}
                  <div className="flex rounded-md border border-border overflow-hidden">
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors', !view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(false)}>2D</button>
                    <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', view3D ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setView3D(true)}>3D</button>
                  </div>

                  {/* Side-by-side - 3D only */}
                  {view3D && (
                    <button
                      title="Side by side"
                      onClick={() => setSbs3D(v => !v)}
                      className={cn('flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors',
                        sbs3D ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted')}
                    >
                      <Columns2 className="size-3" />
                      Side by side
                    </button>
                  )}

                  {/* Before / After - 3D single-view only */}
                  {view3D && !sbs3D && (
                    <div className="flex rounded-md border border-border overflow-hidden">
                      <button className={cn('px-3 py-1 text-xs font-medium transition-colors', show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(true)}>Before</button>
                      <button className={cn('px-3 py-1 text-xs font-medium transition-colors border-l border-border', !show3DBefore ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')} onClick={() => setShow3DBefore(false)}>After</button>
                    </div>
                  )}

                  {/* Play / Pause - shared for both 2D and 3D */}
                  <button
                    onClick={() => setPaused3D(v => !v)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
                    title={paused3D ? 'Resume' : 'Pause'}
                  >
                    {paused3D ? <Play className="size-3" /> : <Pause className="size-3" />}
                    {paused3D ? 'Play' : 'Pause'}
                  </button>

                  {/* Speed - shared for both 2D and 3D */}
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

                  {/* Present mode button */}
                  <button
                    title="Present / council view - hides all chrome"
                    onClick={() => setPresentMode(true)}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:bg-muted transition-colors"
                  >
                    <MonitorPlay className="size-3" />
                    Present
                  </button>
                </div>
              </div>

              {!view3D && (
                <DualIntersectionCanvas
                  chunk={activeChunk}
                  timing={activeTiming}
                  signalStatus={displayData.signal_status}
                  typeMix={typeMix}
                  paused={paused3D}
                  speed={speed3D}
                  streets={streets}
                  existingCycleS={intersection?.existing_cycle_length ?? null}
                  existingGreenSplits={intersection?.existing_green_splits ?? null}
                />
              )}

              {view3D && activeTiming && activeChunk && !sbs3D && (
                <IntersectionScene3D
                  timing={activeTiming}
                  streets={streets}
                  signalOff={activeTiming.signal_off}
                  volumePcuHr={effectiveVolumePcuHr}
                  typeMix={typeMix}
                  showBefore={show3DBefore}
                  signalStatus={displayData.signal_status}
                  existingCycleS={intersection?.existing_cycle_length ?? null}
                  existingGreenSplits={intersection?.existing_green_splits ?? null}
                  paused={paused3D}
                  speed={speed3D}
                  sim={activeChunk}
                />
              )}

              {view3D && activeTiming && activeChunk && sbs3D && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground text-center mb-1.5">Current timing (before)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={effectiveVolumePcuHr}
                      typeMix={typeMix}
                      showBefore={true}
                      signalStatus={displayData.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                      sim={activeChunk}
                    />
                  </div>
                  <div>
                    <p className="text-xs text-emerald-600 text-center mb-1.5">Webster timing (after)</p>
                    <IntersectionScene3D
                      timing={activeTiming}
                      streets={streets}
                      signalOff={activeTiming.signal_off}
                      volumePcuHr={effectiveVolumePcuHr}
                      typeMix={typeMix}
                      showBefore={false}
                      signalStatus={displayData.signal_status}
                      existingCycleS={intersection?.existing_cycle_length ?? null}
                      existingGreenSplits={intersection?.existing_green_splits ?? null}
                      paused={paused3D}
                      speed={speed3D}
                      height={340}
                      sim={activeChunk}
                    />
                  </div>
                </div>
              )}

              {view3D && !activeTiming && (
                <div className="flex items-center justify-center h-48 text-xs text-muted-foreground">
                  No timing data for this chunk - regenerate recommendation to enable 3D view.
                </div>
              )}
            </div>
          )}

          {/* Calculation basis */}
          {activeTiming && (
            <div className="rounded-lg border border-border bg-card p-5 print:hidden">
              <h2 className="text-sm font-semibold mb-3">Calculation basis - {activeTiming.chunk_name}</h2>

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
                    Observed approach flows - 7-day average (PCU/hr)
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {Object.entries(activeTiming.measured_flows).map(([sid, flow], idx) => {
                      const st = streets.find(s => String(s.id) === sid);
                      const label = st
                        ? `${ARM_SHORT[st.arm_direction] ?? '?'} - ${st.name}`
                        : `Approach ${sid}`;
                      return (
                        <div key={sid} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-center">
                          <div
                            className="text-[9px] uppercase tracking-wide leading-tight"
                            style={{ color: APPROACH_COLORS[idx % APPROACH_COLORS.length] }}
                          >
                            {label}
                          </div>
                          <div className="text-xs font-semibold mt-0.5">{flow} PCU/hr</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No observed flow data for this chunk - timing uses minimum cycle length ({activeTiming.cycle_length}s).
                </p>
              )}
            </div>
          )}

          {displayData.chunks.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <TrendingDown className="size-10 opacity-30" />
              <p className="text-sm">No simulation data - regenerate the recommendation to compute delay estimates.</p>
            </div>
          )}

          {/* Per-approach action card + narrative summary - visible on-screen and at the bottom of the print */}
          {intersection && (
            <div className="mt-2 print:mt-3">
              <IntersectionSummary
                intersection={intersection}
                streets={streets}
                sim={displayData}
                rec={rec}
              />
            </div>
          )}
        </>
      )}

      {/* Present / council mode overlay - hides all nav chrome for clean screenshots */}
      {presentMode && activeChunk && data && (
        <div className="fixed inset-0 z-[100] bg-[#0a0f1a] flex flex-col">
          {/* Minimal header */}
          <div className="flex items-center justify-between px-6 py-3 shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-white">{displayData.intersection_name}</span>
              <span className="text-[11px] text-white/40 font-mono">{activeChunk.chunk_name}</span>
            </div>
            <div className="flex items-center gap-6">
              {activeChunk.vehicle_hours_saved > 0 && (
                <div className="text-right">
                  <p className="text-[10px] text-white/40 uppercase tracking-wide">Vehicle-hours saved</p>
                  <p className="text-xl font-semibold tabular-nums text-emerald-400">
                    {activeChunk.vehicle_hours_saved.toFixed(2)} vh
                  </p>
                </div>
              )}
              <button
                onClick={() => setPresentMode(false)}
                className="text-white/40 hover:text-white transition-colors p-1"
                title="Exit present mode (Esc)"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>

          {/* Minimal controls */}
          <div className="flex items-center gap-2 px-6 pb-2 shrink-0">
            <div className="flex rounded-md border border-white/20 overflow-hidden text-xs">
              <button
                className={cn('px-3 py-1 font-medium transition-colors', !view3D ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                onClick={() => setView3D(false)}
              >2D</button>
              <button
                className={cn('px-3 py-1 font-medium transition-colors border-l border-white/20', view3D ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                onClick={() => setView3D(true)}
              >3D</button>
            </div>
            {view3D && activeTiming && (
              <>
                <button
                  onClick={() => setSbs3D(v => !v)}
                  className={cn('flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors',
                    sbs3D ? 'bg-white/20 text-white border-white/30' : 'border-white/20 text-white/40 hover:bg-white/10')}
                >
                  <Columns2 className="size-3" /> Side by side
                </button>
                {!sbs3D && (
                  <div className="flex rounded-md border border-white/20 overflow-hidden text-xs">
                    <button
                      className={cn('px-3 py-1 font-medium transition-colors', show3DBefore ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                      onClick={() => setShow3DBefore(true)}
                    >Before</button>
                    <button
                      className={cn('px-3 py-1 font-medium transition-colors border-l border-white/20', !show3DBefore ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                      onClick={() => setShow3DBefore(false)}
                    >After</button>
                  </div>
                )}
                <button
                  onClick={() => setPaused3D(v => !v)}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-white/20 text-white/40 hover:bg-white/10 transition-colors"
                >
                  {paused3D ? <Play className="size-3" /> : <Pause className="size-3" />}
                  {paused3D ? 'Play' : 'Pause'}
                </button>
                <div className="flex rounded-md border border-white/20 overflow-hidden">
                  {([1, 2, 4] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSpeed3D(s)}
                      className={cn('px-2.5 py-1 text-xs font-medium transition-colors border-l first:border-l-0 border-white/20',
                        speed3D === s ? 'bg-white/20 text-white' : 'text-white/40 hover:bg-white/10')}
                    >{s}×</button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Simulation body */}
          <div className="flex-1 overflow-hidden px-4 pb-4">
            {!view3D && activeChunk && (
              <DualIntersectionCanvas
                chunk={activeChunk}
                timing={activeTiming}
                signalStatus={displayData.signal_status}
                typeMix={typeMix}
                paused={paused3D}
                speed={speed3D}
                streets={streets}
                existingCycleS={intersection?.existing_cycle_length ?? null}
                existingGreenSplits={intersection?.existing_green_splits ?? null}
              />
            )}
            {view3D && activeTiming && activeChunk && !sbs3D && (
              <IntersectionScene3D
                timing={activeTiming}
                streets={streets}
                signalOff={activeTiming.signal_off}
                volumePcuHr={activeChunk.volume_pcu_hr}
                typeMix={typeMix}
                showBefore={show3DBefore}
                signalStatus={displayData.signal_status}
                existingCycleS={intersection?.existing_cycle_length ?? null}
                existingGreenSplits={intersection?.existing_green_splits ?? null}
                paused={paused3D}
                speed={speed3D}
                height={window.innerHeight - 140}
                sim={activeChunk}
              />
            )}
            {view3D && activeTiming && activeChunk && sbs3D && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-white/40 text-center mb-1.5">Current timing (before)</p>
                  <IntersectionScene3D
                    timing={activeTiming}
                    streets={streets}
                    signalOff={activeTiming.signal_off}
                    volumePcuHr={effectiveVolumePcuHr}
                    typeMix={typeMix}
                    showBefore={true}
                    signalStatus={displayData.signal_status}
                    existingCycleS={intersection?.existing_cycle_length ?? null}
                    existingGreenSplits={intersection?.existing_green_splits ?? null}
                    paused={paused3D}
                    speed={speed3D}
                    height={window.innerHeight - 160}
                    sim={activeChunk}
                  />
                </div>
                <div>
                  <p className="text-[11px] text-emerald-400 text-center mb-1.5">Webster timing (after)</p>
                  <IntersectionScene3D
                    timing={activeTiming}
                    streets={streets}
                    signalOff={activeTiming.signal_off}
                    volumePcuHr={effectiveVolumePcuHr}
                    typeMix={typeMix}
                    showBefore={false}
                    signalStatus={displayData.signal_status}
                    existingCycleS={intersection?.existing_cycle_length ?? null}
                    existingGreenSplits={intersection?.existing_green_splits ?? null}
                    paused={paused3D}
                    speed={speed3D}
                    height={window.innerHeight - 160}
                    sim={activeChunk}
                  />
                </div>
              </div>
            )}
            {view3D && !activeTiming && (
              <div className="flex items-center justify-center h-48 text-xs text-white/30">
                No timing data for this chunk - regenerate recommendation to enable 3D view.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit signal timing dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit signal timing</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label>Signal type</Label>
              <div className="flex gap-2">
                {(['fixed_time', 'actuated', 'unsignalized'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setEditStatus(s)}
                    className={cn(
                      'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                      editStatus === s
                        ? 'bg-foreground text-background border-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {s === 'fixed_time' ? 'Fixed-time' : s === 'actuated' ? 'Actuated' : 'Unsignalized'}
                  </button>
                ))}
              </div>
            </div>

            {editStatus !== 'unsignalized' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit-cycle">Cycle length (seconds)</Label>
                  <Input
                    id="edit-cycle"
                    type="number"
                    min={20}
                    max={180}
                    value={editCycle}
                    onChange={e => setEditCycle(e.target.value)}
                    placeholder="e.g. 90"
                  />
                </div>

                {streets.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Label>Green time per approach (seconds)</Label>
                    {streets.map(s => (
                      <div key={s.id} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-28 shrink-0 truncate capitalize">
                          {s.arm_direction !== 'unknown' ? s.arm_direction : s.name}
                        </span>
                        <Input
                          type="number"
                          min={5}
                          max={120}
                          value={editSplits[s.id] ?? ''}
                          onChange={e => setEditSplits(prev => ({ ...prev, [s.id]: e.target.value }))}
                          placeholder="e.g. 22"
                          className="h-8 text-sm"
                        />
                        <span className="text-xs text-muted-foreground shrink-0">s</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={saveEdit} disabled={editSaving}>
              {editSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
