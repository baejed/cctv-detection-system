import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { cctvsApi } from '@/services/cctvs';
import { aggregationApi } from '@/services/aggregation';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection, Street, CCTV, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { SettingsSheet } from '@/components/IntersectionSettingsSheet';
import { AllClearMascot } from '@/components/AllClearMascot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Plus, Settings2, WifiOff, Wifi, RefreshCw,
  Loader2, TrendingUp, AlertTriangle,
  Rocket, LayoutGrid, Map as MapIcon, MonitorPlay,
  ArrowRight, Activity, Clock,
  CheckCircle2, Camera,
} from 'lucide-react';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';

// ── Time-of-day chunks (mirror server/tod.py TOD_DEFAULTS) ───────────────────

const TOD_DEFAULTS: { name: string; startMin: number; endMin: number }[] = [
  { name: 'Overnight', startMin:    0, endMin:  360 },
  { name: 'AM Rush',   startMin:  360, endMin:  540 },
  { name: 'Midday',    startMin:  540, endMin:  720 },
  { name: 'PM Rush',   startMin:  720, endMin: 1080 },
  { name: 'Evening',   startMin: 1080, endMin: 1440 },
];

function formatHHMM(min: number): string {
  if (min === 1440) return '24:00';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function useCurrentChunk(now: Date) {
  return useMemo(() => {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const found = TOD_DEFAULTS.find(c => c.startMin <= minutes && minutes < c.endMin) ?? TOD_DEFAULTS[0];
    return {
      name: found.name,
      window: `${formatHHMM(found.startMin)}–${formatHHMM(found.endMin)}`,
    };
  }, [now]);
}

function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Track when SSE last delivered data; report stale if no events for >60s.
function useSseFreshness(sseData: unknown, sseStatus: SSEStatus): boolean {
  const lastEventRef = useRef<number>(0);
  const [stale, setStale] = useState<boolean>(true);

  useEffect(() => {
    if (sseData != null) {
      lastEventRef.current = Date.now();
      setStale(false);
    }
  }, [sseData]);

  useEffect(() => {
    const id = setInterval(() => {
      const since = Date.now() - lastEventRef.current;
      const connectionDead = sseStatus === 'disconnected' || sseStatus === 'server_offline';
      const noEventsYet = lastEventRef.current === 0;
      setStale(connectionDead || noEventsYet || since > 60_000);
    }, 5_000);
    return () => clearInterval(id);
  }, [sseStatus]);

  return stale;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Map view ──────────────────────────────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [7.4478, 125.8075];

function densityColor(count: number): string {
  if (count === 0)  return '#6b7280';
  if (count < 50)   return '#22c55e';
  if (count < 150)  return '#f59e0b';
  if (count < 400)  return '#f97316';
  return                   '#ef4444';
}

function densityLabel(count: number): string {
  if (count === 0)  return 'No data';
  if (count < 50)   return 'Low';
  if (count < 150)  return 'Moderate';
  if (count < 400)  return 'High';
  return                   'Very High';
}

function MapAutoFit({ intersections }: { intersections: Intersection[] }) {
  const map  = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const first = intersections.find(i => i.latitude && i.longitude);
    if (first) { map.setView([first.latitude, first.longitude], 14); done.current = true; }
  }, [intersections, map]);
  return null;
}

interface DensityMapProps {
  intersections:  Intersection[];
  sseData:        AggregationRow[] | null;
  onOpenSettings: (inter: Intersection) => void;
}

function DensityMap({ intersections, sseData, onOpenSettings }: DensityMapProps) {
  const byInter = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of sseData ?? []) m.set(r.intersection_id, (m.get(r.intersection_id) ?? 0) + r.count);
    return m;
  }, [sseData]);

  const maxTotal  = Math.max(1, ...byInter.values());
  const mappable  = intersections.filter(i => i.latitude && i.longitude);
  const center: [number, number] = mappable[0]
    ? [mappable[0].latitude, mappable[0].longitude]
    : DEFAULT_CENTER;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
        {(['No data:#6b7280', 'Low:#22c55e', 'Moderate:#f59e0b', 'High:#f97316', 'Very High:#ef4444']).map(entry => {
          const [label, color] = entry.split(':');
          return (
            <span key={label} className="flex items-center gap-1">
              <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              {label}
            </span>
          );
        })}
        <span className="ml-auto opacity-60">{sseData && sseData.length > 0 ? 'live' : 'no data'}</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border" style={{ height: 460, isolation: 'isolate' }}>
        <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <MapAutoFit intersections={intersections} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {mappable.map(inter => {
            const total  = byInter.get(inter.id) ?? 0;
            const color  = densityColor(total);
            const radius = 12 + Math.round(20 * (total / maxTotal));
            return (
              <CircleMarker
                key={inter.id}
                center={[inter.latitude, inter.longitude]}
                radius={radius}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.65, weight: 1.5 }}
                eventHandlers={{ click: () => onOpenSettings(inter) }}
              >
                <Popup>
                  <div className="text-xs min-w-[140px]">
                    <p className="font-semibold mb-1">{inter.name}</p>
                    <p style={{ color }}>{densityLabel(total)} · {total} detected today</p>
                    <p className="text-muted-foreground mt-1 text-[10px]">Click to configure</p>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}

// ── Daily traffic stats ──────────────────────────────────────────────────────

interface DailyStats {
  total: number;
  peakCount: number;
  peakHour: string | null;
}

function formatPeakHour(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString([], { hour: 'numeric', hour12: true });
}


// ── Warrant badge ────────────────────────────────────────────────────────────

function WarrantBadge({ rec }: { rec: RecommendationResponse | undefined }) {
  if (!rec) {
    return (
      <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground bg-muted/40">
        No analysis yet
      </Badge>
    );
  }
  const b = statusBucket(rec);
  return (
    <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[b])}>
      {BUCKET_LABEL[b]}
    </Badge>
  );
}

// ── Intersection card ────────────────────────────────────────────────────────

interface CardProps {
  inter: Intersection;
  cameras: CCTV[];
  rec: RecommendationResponse | undefined;
  streets: Street[];
  liveCount: number;
  dailyStats: DailyStats | undefined;
  onRefresh: () => void;
  onOpenSettings: (inter: Intersection) => void;
}

function IntersectionCard({ inter, cameras, rec, streets, liveCount, dailyStats, onRefresh, onOpenSettings }: CardProps) {
  const [generating, setGenerating] = useState(false);
  const bucket = rec ? statusBucket(rec) : null;
  const offlineCount = cameras.filter(c => c.status !== 'online').length;

  async function generate() {
    setGenerating(true);
    try {
      await recommendationsApi.generate(inter.id);
      toast.success('Analysis complete');
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  const total = dailyStats?.total ?? 0;
  const peakCount = dailyStats?.peakCount ?? 0;
  const peakHour = formatPeakHour(dailyStats?.peakHour ?? null);

  return (
    <div data-testid="intersection-card" data-intersection-id={inter.id} className="rounded-xl border border-border bg-card flex flex-col overflow-hidden h-full">
      <div className={cn(
        'h-1',
        bucket === 'warranted'     && 'bg-emerald-500',
        bucket === 'borderline'    && 'bg-amber-400',
        bucket === 'not_warranted' && 'bg-muted',
        (bucket === 'no_data' || !bucket) && 'bg-muted/40',
      )} />

      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-1.5">
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <Link to={`/intersections/${inter.id}`} className="font-semibold text-sm leading-tight truncate hover:underline underline-offset-2">
              {inter.name}
            </Link>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                {inter.signal_status.replace('_', ' ')}
              </Badge>
              <WarrantBadge rec={rec} />
            </div>
          </div>
          <button
            onClick={() => onOpenSettings(inter)}
            className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={`Settings for ${inter.name}`}
          >
            <Settings2 className="size-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="rounded-md bg-muted/40 px-1.5 py-1.5">
            <div className="flex items-center justify-center gap-1 text-[9px] uppercase text-muted-foreground">
              <Activity className="size-2.5" /> Today
            </div>
            <p className="text-sm font-bold tabular-nums leading-none mt-1">{total.toLocaleString()}</p>
          </div>
          <div className="rounded-md bg-muted/40 px-1.5 py-1.5">
            <div className="flex items-center justify-center gap-1 text-[9px] uppercase text-muted-foreground">
              <Clock className="size-2.5" /> Peak
            </div>
            <p className="text-sm font-bold tabular-nums leading-none mt-1">{peakCount.toLocaleString()}</p>
          </div>
          <div className="rounded-md bg-muted/40 px-1.5 py-1.5">
            <div className="text-[9px] uppercase text-muted-foreground">Peak hr</div>
            <p className="text-sm font-bold tabular-nums leading-none mt-1">{peakHour}</p>
          </div>
        </div>

        {bucket === 'warranted' && rec?.timing_cycle && (
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
            <TrendingUp className="size-3 shrink-0" />
            <span className="font-medium truncate">{rec.timing_cycle}s cycle{rec.timing_chunk && ` · ${rec.timing_chunk}`}</span>
          </div>
        )}

        {(streets.length === 0 || offlineCount > 0 || liveCount > 0) && (
          <div className="flex items-center gap-2 text-[10px] flex-wrap">
            {liveCount > 0 && (
              <span className="flex items-center gap-1 text-emerald-600 font-medium">
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {liveCount} live
              </span>
            )}
            {streets.length === 0 && (
              <span className="flex items-center gap-1 text-amber-600">
                <AlertTriangle className="size-3" /> no approaches
              </span>
            )}
            {offlineCount > 0 && (
              <Link to="/cameras" className="flex items-center gap-1 text-red-600 hover:underline ml-auto">
                <WifiOff className="size-3" /> {offlineCount} offline
              </Link>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 mt-auto pt-1">
          <Link to={`/intersections/${inter.id}`} className="flex-1">
            <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 w-full px-1.5">
              <MonitorPlay className="size-2.5" />
              Live
            </Button>
          </Link>
          <Link to={`/intersections/${inter.id}/timing`} className="flex-1">
            <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 w-full px-1.5">
              <TrendingUp className="size-2.5" />
              Timing
            </Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] gap-1 px-1.5"
            data-testid="btn-run-analysis"
            onClick={generate}
            disabled={generating}
            aria-label="Run analysis"
          >
            {generating
              ? <Loader2 className="size-2.5 animate-spin" />
              : <RefreshCw className="size-2.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Hero stats ────────────────────────────────────────────────────────────────

function TrafficShareByIntersection({
  intersections,
  liveCountByIntersection,
}: {
  intersections: Intersection[];
  liveCountByIntersection: Record<number, number>;
}) {
  const data = useMemo(() => {
    return intersections
      .map(i => ({ id: i.id, name: i.name, value: liveCountByIntersection[i.id] ?? 0 }))
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [intersections, liveCountByIntersection]);

  const total = data.reduce((s, d) => s + d.value, 0);
  const max = data[0]?.value ?? 0;
  const TOP_N = 5;
  const visible = data.slice(0, TOP_N);
  const overflow = Math.max(0, data.length - TOP_N);

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
        <p className="text-xs text-muted-foreground">No live traffic detected yet</p>
        <p className="text-[11px] text-muted-foreground/70">data will appear when cameras report detections</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {visible.map((d, i) => {
        const pct = total > 0 ? (d.value / total) * 100 : 0;
        const barPct = max > 0 ? (d.value / max) * 100 : 0;
        return (
          <Link
            key={d.id}
            to={`/intersections/${d.id}`}
            className="group flex flex-col gap-1 rounded-md px-2 -mx-2 py-1.5 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[11px] font-mono tabular-nums text-muted-foreground/70 w-4 text-right shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm font-medium truncate text-foreground">
                  {d.name}
                </span>
              </div>
              <div className="flex items-baseline gap-2 shrink-0">
                <span className="text-sm font-semibold tabular-nums">{d.value.toLocaleString()}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums w-9 text-right">
                  {pct.toFixed(0)}%
                </span>
              </div>
            </div>
            <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/70 group-hover:bg-foreground transition-colors"
                style={{ width: `${barPct}%` }}
              />
            </div>
          </Link>
        );
      })}
      {overflow > 0 && (
        <p className="text-[11px] text-muted-foreground px-1 pt-1">
          + {overflow} more intersection{overflow === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}

// ── Cameras card (standalone, left column top) ───────────────────────────────

function CamerasCard({ cameras }: { cameras: CCTV[] }) {
  const total   = cameras.length;
  const live    = cameras.filter(c => c.status === 'online').length;
  const offline = cameras.filter(c => c.status === 'offline').length;
  const allUp = offline === 0;
  const href = offline > 0 ? '/cameras?status=offline' : '/cameras';

  if (total === 0) {
    return (
      <Card>
        <Link to="/cameras" data-testid="dash-camera-card" className="block">
          <CardContent className="p-4 flex items-start justify-between">
            <div>
              <div className="text-2xl font-black tabular-nums text-muted-foreground">-</div>
              <div className="text-xs text-muted-foreground/70 mt-0.5">no cameras connected</div>
            </div>
            <Camera className="size-5 text-muted-foreground/30 mt-0.5" />
          </CardContent>
        </Link>
      </Card>
    );
  }

  return (
    <Card className={cn(
      allUp
        ? 'border-emerald-100 bg-emerald-50/60 dark:bg-emerald-950/20'
        : 'border-red-100 bg-red-50/60 dark:bg-red-950/20',
    )}>
      <Link to={href} data-testid="dash-camera-card" className="block">
        <CardContent className="p-4 flex items-start justify-between">
          <div>
            <div className={cn(
              'text-2xl font-black tabular-nums',
              allUp ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
            )}>
              {live}<span className="text-muted-foreground/70"> / {total}</span>
            </div>
            <div className={cn(
              'text-xs mt-0.5',
              allUp ? 'text-emerald-600/70 dark:text-emerald-400/70' : 'text-red-600/70 dark:text-red-400/70',
            )}>
              {allUp ? 'cameras live · all operating' : `cameras live · ${offline} offline`}
            </div>
          </div>
          {allUp
            ? <Wifi className="size-5 text-emerald-300 dark:text-emerald-700 mt-0.5" />
            : <WifiOff className="size-5 text-red-300 dark:text-red-700 mt-0.5" />}
        </CardContent>
      </Link>
    </Card>
  );
}

// ── Needs Action card (right column hero) ────────────────────────────────────

type InterventionKind = 'signalize' | 'road_widening' | 'timing_only';

// Three lanes separate "I can act today" from "I escalate" from "watch list":
//   deploy   → timing change valid in the current TOD chunk, push to controller
//   escalate → signal install or widening, weeks/months out, route to engineering
//   later    → timing change for a future TOD chunk today
type ActionLane = 'deploy' | 'escalate' | 'later';

type ActionItem = {
  inter: Intersection;
  rec: RecommendationResponse;
  verb: string;
  chunkLabel: string | null;  // null → anytime / signal install
  lane: ActionLane;
  kind: InterventionKind;
  severity: number;  // recommended_confidence × peak volume - used for ordering
};

// ── Since-when ───────────────────────────────────────────────────────────────

function formatSince(iso: string | null | undefined, refMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaSec = Math.max(0, Math.round((refMs - t) / 1000));
  if (deltaSec < 60) return 'just now';
  const m = Math.round(deltaSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function provenanceTitle(rec: RecommendationResponse): string {
  const major = rec.major_volume ?? 0;
  const minor = rec.minor_volume ?? 0;
  const total = major + minor;
  const hour = rec.hour_start
    ? new Date(rec.hour_start).toLocaleTimeString([], { hour: 'numeric', hour12: true })
    : null;
  const ageH = rec.data_age_hours;
  const parts = [
    `Confidence based on ${total.toLocaleString()} veh/h at peak (major ${major.toLocaleString()} / minor ${minor.toLocaleString()})`,
  ];
  if (hour) parts.push(`Peak hour: ${hour}`);
  if (ageH != null) parts.push(`Data age: ${ageH < 1 ? '<1h' : `${Math.round(ageH)}h`}`);
  return parts.join(' · ');
}

// Single small color cue per row (Linear/Datadog-style). Used only for the
// status dot - keep the rest of the row monochrome so typography hierarchy
// reads as the primary signal, not color.
const KIND_DOT: Record<InterventionKind, string> = {
  road_widening: 'bg-red-500',     // most urgent: structural fix
  signalize:     'bg-amber-500',   // medium: install a signal
  timing_only:   'bg-sky-500',     // light: parameter tune
};

const KIND_LABEL: Record<InterventionKind, string> = {
  road_widening: 'Widen',
  signalize:     'Signalize',
  timing_only:   'Adjust',
};

function buildActionItem(
  inter: Intersection,
  rec: RecommendationResponse,
  currentChunkName: string,
): ActionItem {
  const signalized = inter.signal_status !== 'unsignalized';
  // Prefer the backend's classified intervention; fall back to the signalize/
  // timing-only inference for older rows that pre-date the field.
  const kind: InterventionKind = rec.intervention?.class
    ?? (signalized ? 'timing_only' : 'signalize');

  const totalVolume = (rec.major_volume ?? 0) + (rec.minor_volume ?? 0);
  // Severity ranks rows that are both confident and high-impact ahead of
  // confident-but-quiet ones. Falls back to confidence alone when volume is
  // missing so older recs don't sink to the bottom.
  const severity = (rec.recommended_confidence ?? 0) * (totalVolume || 1);

  if (kind === 'signalize') {
    return { inter, rec, verb: 'Install signal', chunkLabel: null, lane: 'escalate', kind, severity };
  }
  if (kind === 'road_widening') {
    return { inter, rec, verb: 'Add capacity (widen)', chunkLabel: null, lane: 'escalate', kind, severity };
  }
  const chunk = rec.timing_chunk;
  const cycle = rec.timing_cycle;
  const verb = cycle != null
    ? `Adjust timing to ${cycle}s cycle`
    : 'Timing adjustment recommended';
  if (chunk == null || chunk === currentChunkName) {
    return { inter, rec, verb, chunkLabel: chunk, lane: 'deploy', kind, severity };
  }
  return { inter, rec, verb, chunkLabel: chunk, lane: 'later', kind, severity };
}

function NeedsActionBigRow({ item, nowMs }: { item: ActionItem; nowMs: number }) {
  const pct = item.rec.recommended_confidence != null
    ? Math.round(item.rec.recommended_confidence * 100)
    : null;
  const detail = item.chunkLabel ? `${item.verb} · ${item.chunkLabel}` : item.verb;
  const since = formatSince(item.rec.generated_at, nowMs);
  return (
    <Link
      to={`/intersections/${item.inter.id}`}
      data-testid="needs-action-row"
      className="group flex items-center gap-3 rounded-md px-2 -mx-2 py-2 hover:bg-muted/50 transition-colors"
    >
      <span className={cn('size-2 rounded-full shrink-0', KIND_DOT[item.kind])} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold leading-tight truncate text-foreground">
            {item.inter.name}
          </p>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-medium shrink-0">
            {KIND_LABEL[item.kind]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {detail}
        </p>
      </div>
      {since && (
        <span
          className="text-[11px] tabular-nums text-muted-foreground/80 shrink-0"
          title={`Warranted since ${new Date(item.rec.generated_at).toLocaleString()}`}
        >
          {since}
        </span>
      )}
      {pct != null && (
        <span
          className="text-sm font-semibold tabular-nums text-foreground/80 w-12 text-right shrink-0"
          title={provenanceTitle(item.rec)}
        >
          {pct}%
        </span>
      )}
      <ArrowRight className="size-4 text-muted-foreground/60 group-hover:text-foreground transition-colors shrink-0" />
    </Link>
  );
}

function NeedsActionCompactRow({ item, nowMs }: { item: ActionItem; nowMs: number }) {
  const pct = item.rec.recommended_confidence != null
    ? Math.round(item.rec.recommended_confidence * 100)
    : null;
  const since = formatSince(item.rec.generated_at, nowMs);
  return (
    <Link
      to={`/intersections/${item.inter.id}`}
      className="group flex items-center gap-2 rounded-md px-2 -mx-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
    >
      <span className={cn('size-1.5 rounded-full shrink-0', KIND_DOT[item.kind])} aria-hidden />
      <span className="flex-1 font-medium truncate text-foreground/90">{item.inter.name}</span>
      <span className="text-muted-foreground truncate hidden sm:inline">{item.verb}</span>
      {item.chunkLabel && (
        <span className="text-[10px] text-muted-foreground/70 shrink-0 hidden md:inline">{item.chunkLabel}</span>
      )}
      {since && (
        <span
          className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0 hidden md:inline"
          title={`Warranted since ${new Date(item.rec.generated_at).toLocaleString()}`}
        >
          {since}
        </span>
      )}
      {pct != null && (
        <span
          className="font-mono tabular-nums text-muted-foreground/80 w-9 text-right"
          title={provenanceTitle(item.rec)}
        >
          {pct}%
        </span>
      )}
      <ArrowRight className="size-3 text-muted-foreground/50 group-hover:text-foreground transition-colors shrink-0" />
    </Link>
  );
}

function NeedsActionCard({
  deploy,
  escalate,
  later,
  currentChunkName,
  nowMs,
}: {
  deploy: ActionItem[];
  escalate: ActionItem[];
  later: ActionItem[];
  currentChunkName: string;
  nowMs: number;
}) {
  const DEPLOY_LIMIT = 6;
  const ESCALATE_LIMIT = 4;
  const LATER_LIMIT = 6;
  const deployDisplayed = deploy.slice(0, DEPLOY_LIMIT);
  const deployOverflow = Math.max(0, deploy.length - DEPLOY_LIMIT);
  const escalateDisplayed = escalate.slice(0, ESCALATE_LIMIT);
  const escalateOverflow = Math.max(0, escalate.length - ESCALATE_LIMIT);
  const laterDisplayed = later.slice(0, LATER_LIMIT);
  const laterOverflow = Math.max(0, later.length - LATER_LIMIT);
  const total = deploy.length + escalate.length + later.length;

  return (
    <Card data-testid="needs-action-card" className="h-full w-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <CardTitle className="text-base font-semibold tracking-tight">
              Needs action
            </CardTitle>
            <span className="text-sm text-muted-foreground tabular-nums">{total}</span>
          </div>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            during <span className="text-foreground font-medium">{currentChunkName}</span>
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section data-testid="needs-action-deploy" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Suggested today
            </h3>
            <span className="text-[10px] text-muted-foreground/70">timing adjustments · review before applying</span>
          </div>
          {deployDisplayed.length === 0 ? (
            <p className="text-xs text-muted-foreground italic px-1 py-1.5">
              No timing adjustments suggested for the current chunk.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {deployDisplayed.map(item => (
                <NeedsActionBigRow key={item.inter.id} item={item} nowMs={nowMs} />
              ))}
              {deployOverflow > 0 && (
                <p className="text-[11px] text-muted-foreground px-1">
                  + {deployOverflow} more - see intersection list
                </p>
              )}
            </div>
          )}
        </section>

        {(escalateDisplayed.length > 0 || escalateOverflow > 0) && (
          <section data-testid="needs-action-escalate" className="flex flex-col gap-2 pt-3 border-t border-border/60">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Escalate
              </h3>
              <span className="text-[10px] text-muted-foreground/70">capital project · route to engineering</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {escalateDisplayed.map(item => (
                <NeedsActionBigRow key={item.inter.id} item={item} nowMs={nowMs} />
              ))}
              {escalateOverflow > 0 && (
                <p className="text-[11px] text-muted-foreground px-1">
                  + {escalateOverflow} more
                </p>
              )}
            </div>
          </section>
        )}

        {(laterDisplayed.length > 0 || laterOverflow > 0) && (
          <section data-testid="needs-action-later" className="flex flex-col gap-2 pt-3 border-t border-border/60">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Later today
            </h3>
            <div className="flex flex-col gap-1">
              {laterDisplayed.map(item => (
                <NeedsActionCompactRow key={item.inter.id} item={item} nowMs={nowMs} />
              ))}
              {laterOverflow > 0 && (
                <p className="text-[11px] text-muted-foreground px-1">
                  + {laterOverflow} more
                </p>
              )}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

// ── All-clear empty state ────────────────────────────────────────────────────

function AllClearPanel({
  totalIntersections,
  analysedCount,
  lastAnalysedAt,
}: {
  totalIntersections: number;
  analysedCount: number;
  lastAnalysedAt: Date | null;
}) {
  const lastAnalysed = lastAnalysedAt
    ? formatClock(lastAnalysedAt)
    : '-';
  return (
    <Card
      data-testid="all-clear-panel"
      className="h-full w-full overflow-hidden border-emerald-100 bg-gradient-to-br from-emerald-50/80 via-emerald-50/40 to-white dark:from-emerald-950/30 dark:via-emerald-950/10 dark:to-background"
    >
      <CardContent className="flex flex-col sm:flex-row items-center justify-center gap-6 py-6 text-center sm:text-left">
        <AllClearMascot size={160} className="shrink-0 drop-shadow-sm" />
        <div className="flex flex-col gap-2 max-w-md">
          <span className="inline-flex items-center gap-1.5 self-center sm:self-start rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-3" />
            All clear
          </span>
          <p className="text-lg font-semibold text-emerald-900 dark:text-emerald-200 leading-tight">
            Everything's running within warrants - nothing to act on.
          </p>
          <p className="text-xs text-muted-foreground">
            {totalIntersections} intersection{totalIntersections === 1 ? '' : 's'} monitored · {analysedCount} analysed · 0 warranted
          </p>
          <p className="text-[10px] uppercase tracking-wide text-emerald-700/80 dark:text-emerald-500/80 mt-1">
            Last analysed {lastAnalysed} · auto-refreshes every 5 min
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Dashboard strip (replaces page header row) ───────────────────────────────

function DashboardStrip({
  intersectionCount,
  chunkName,
  chunkWindow,
  now,
  lastAnalysedAt,
  sseStale,
  viewMode,
  onSetViewMode,
  onRefreshNow,
  refreshing,
  onSetup,
}: {
  intersectionCount: number;
  chunkName: string;
  chunkWindow: string;
  now: Date;
  lastAnalysedAt: Date | null;
  sseStale: boolean;
  viewMode: 'grid' | 'map';
  onSetViewMode: (m: 'grid' | 'map') => void;
  onRefreshNow: () => void;
  refreshing: boolean;
  onSetup: () => void;
}) {
  const lastAnalysed = lastAnalysedAt ? formatClock(lastAnalysedAt) : '-';
  return (
    <div
      data-testid="dashboard-strip"
      className="flex items-center gap-3 flex-wrap rounded-xl border border-border bg-card/60 px-3 py-2"
    >
      <div className="flex items-center gap-2.5">
        <h1 className="text-base font-semibold tracking-tight">Dashboard</h1>
        <span className="text-[10px] text-muted-foreground">
          {intersectionCount} intersection{intersectionCount === 1 ? '' : 's'}
        </span>
      </div>

      <span className="h-4 w-px bg-border" />

      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Currently in</span>
        <span className="text-sm font-semibold">{chunkName}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{chunkWindow}</span>
      </div>

      <div className="ml-auto flex items-center gap-3 flex-wrap">
        {sseStale && (
          <span
            data-testid="strip-stale-badge"
            className="inline-flex items-center gap-1 rounded-md bg-red-100 dark:bg-red-950/40 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-400"
          >
            <AlertTriangle className="size-3" />
            feed stale
          </span>
        )}

        <span className="text-sm font-semibold tabular-nums">{formatClock(now)}</span>

        <span className="text-[11px] text-muted-foreground">
          Last analysed <span className="tabular-nums">{lastAnalysed}</span>
        </span>

        {intersectionCount > 0 && (
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              data-testid="btn-view-grid"
              onClick={() => onSetViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              aria-label="Grid view"
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 text-xs transition-colors',
                viewMode === 'grid' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutGrid className="size-3" />
              Grid
            </button>
            <button
              type="button"
              data-testid="btn-view-map"
              onClick={() => onSetViewMode('map')}
              aria-pressed={viewMode === 'map'}
              aria-label="Map view"
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 text-xs transition-colors border-l border-border',
                viewMode === 'map' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <MapIcon className="size-3" />
              Map
            </button>
          </div>
        )}

        {intersectionCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="btn-run-all-analyses"
            className="h-7 px-2"
            onClick={onRefreshNow}
            disabled={refreshing}
            aria-label="Refresh recommendations now"
            title="Refresh recommendations now"
          >
            {refreshing
              ? <Loader2 className="size-3.5 animate-spin" />
              : <RefreshCw className="size-3.5" />}
          </Button>
        )}

        <Button
          size="sm"
          variant="default"
          data-testid="btn-add-intersection"
          className="h-7 px-2"
          onClick={onSetup}
          title="Set up intersection"
        >
          <Plus className="size-3.5 mr-1" />
          Set up
        </Button>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const VIEW_MODE_KEY = 'dashboard.viewMode';

function readViewMode(): 'grid' | 'map' {
  if (typeof window === 'undefined') return 'map';
  const stored = window.localStorage.getItem(VIEW_MODE_KEY);
  return stored === 'grid' ? 'grid' : 'map';
}

export function IntersectionsPage() {
  const { sseData, sseStatus, onOpenWizard } = useOutletContext<{ sseData: AggregationRow[] | null; sseStatus: SSEStatus; onOpenWizard: (step?: string) => void }>();

  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [streets, setStreets]             = useState<Street[]>([]);
  const [cameras, setCameras]             = useState<CCTV[]>([]);
  const [recs, setRecs]                   = useState<Map<number, RecommendationResponse>>(new Map());
  const [dailyByInter, setDailyByInter]   = useState<Map<number, DailyStats>>(new Map());
  const [loading, setLoading]             = useState(true);
  const [lastAnalysedAt, setLastAnalysedAt] = useState<Date | null>(null);

  const now           = useNow(1000);
  const currentChunk  = useCurrentChunk(now);
  const sseStale      = useSseFreshness(sseData, sseStatus);

  const liveCountByIntersection = useMemo(() => {
    const m: Record<number, number> = {};
    for (const row of sseData ?? []) {
      m[row.intersection_id] = (m[row.intersection_id] ?? 0) + row.count;
    }
    return m;
  }, [sseData]);

  const { deployActions, escalateActions, laterActions, warrantedTotal } = useMemo(() => {
    const all: ActionItem[] = [];
    for (const inter of intersections) {
      const rec = recs.get(inter.id);
      if (!rec || !rec.recommended) continue;
      all.push(buildActionItem(inter, rec, currentChunk.name));
    }
    // Sort by severity (confidence × volume) so high-impact rows lead.
    const bySeverity = (a: ActionItem, b: ActionItem) => b.severity - a.severity;
    return {
      deployActions:   all.filter(a => a.lane === 'deploy').sort(bySeverity),
      escalateActions: all.filter(a => a.lane === 'escalate').sort(bySeverity),
      laterActions:    all.filter(a => a.lane === 'later').sort(bySeverity),
      warrantedTotal:  all.length,
    };
  }, [intersections, recs, currentChunk.name]);

  const [viewMode, setViewModeState]          = useState<'grid' | 'map'>(() => readViewMode());
  const [generatingAll, setGeneratingAll]     = useState(false);
  const [settingsTarget, setSettingsTarget]   = useState<Intersection | null>(null);

  const setViewMode = useCallback((m: 'grid' | 'map') => {
    setViewModeState(m);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_MODE_KEY, m);
    }
  }, []);

  // User-initiated refresh: show feedback via toast/spinner.
  async function runAllAnalyses() {
    setGeneratingAll(true);
    try {
      const results = await recommendationsApi.generateAll();
      setRecs(new Map(results.map(r => [r.intersection_id, r])));
      setLastAnalysedAt(new Date());
      const warranted = results.filter(r => r.recommended).length;
      toast.success(`Analysis complete - ${warranted} warranted`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setGeneratingAll(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date();

      const [ints, strs, cams, recList, hist] = await Promise.all([
        intersectionsApi.list(),
        streetsApi.list(),
        cctvsApi.list(),
        recommendationsApi.list().catch(() => []),
        aggregationApi
          .history({ start: dayStart.toISOString(), end: dayEnd.toISOString(), bucket: 'hour' })
          .catch(() => []),
      ]);
      setIntersections(ints);
      setStreets(strs);
      setCameras(cams);
      setRecs(new Map(recList.map(r => [r.intersection_id, r])));

      // Seed lastAnalysedAt from the most recent recommendation's generated_at,
      // so the strip shows a real timestamp before the first auto-poll fires.
      if (recList.length > 0) {
        const latest = recList.reduce<string | null>((acc, r) => {
          if (!r.generated_at) return acc;
          if (!acc || r.generated_at > acc) return r.generated_at;
          return acc;
        }, null);
        if (latest) {
          const d = new Date(latest);
          if (!Number.isNaN(d.getTime())) setLastAnalysedAt(d);
        }
      }

      const perInterPerHour = new Map<number, Map<string, number>>();
      for (const row of hist) {
        const inner = perInterPerHour.get(row.intersection_id) ?? new Map<string, number>();
        inner.set(row.window_start, (inner.get(row.window_start) ?? 0) + row.count);
        perInterPerHour.set(row.intersection_id, inner);
      }
      const daily = new Map<number, DailyStats>();
      for (const [interId, hours] of perInterPerHour) {
        let total = 0;
        let peakCount = 0;
        let peakHour: string | null = null;
        for (const [hour, count] of hours) {
          total += count;
          if (count > peakCount) { peakCount = count; peakHour = hour; }
        }
        daily.set(interId, { total, peakCount, peakHour });
      }
      setDailyByInter(daily);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Silent auto-poll: regenerate recommendations every 5 min, no toast/spinner.
  // Guarded by an in-flight ref so slow backends don't pile up.
  const pollInFlight = useRef(false);
  useEffect(() => {
    if (intersections.length === 0) return;
    const tick = async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const results = await recommendationsApi.generateAll();
        setRecs(new Map(results.map(r => [r.intersection_id, r])));
        setLastAnalysedAt(new Date());
      } catch {
        // silent on the wall display; errors don't take focus
      } finally {
        pollInFlight.current = false;
      }
    };
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [intersections.length]);

  const analysedCount = recs.size;
  const dimLive = sseStale;

  return (
    <div className="flex flex-col gap-3">
      <DashboardStrip
        intersectionCount={intersections.length}
        chunkName={currentChunk.name}
        chunkWindow={currentChunk.window}
        now={now}
        lastAnalysedAt={lastAnalysedAt}
        sseStale={sseStale}
        viewMode={viewMode}
        onSetViewMode={setViewMode}
        onRefreshNow={runAllAnalyses}
        refreshing={generatingAll}
        onSetup={() => onOpenWizard('discover')}
      />

      {!loading && intersections.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
          <div className="lg:col-span-1 flex flex-col gap-3 h-full">
            <CamerasCard cameras={cameras} />
            <Card
              className={cn(
                'flex-1 transition-opacity',
                dimLive && 'opacity-40',
              )}
              aria-busy={dimLive}
            >
              <CardHeader className="pb-3">
                <div className="flex items-baseline justify-between gap-2">
                  <CardTitle className="text-base font-semibold tracking-tight">
                    Live load
                  </CardTitle>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    last 1 min
                  </span>
                </div>
                <CardDescription className="text-xs">
                  Busiest intersections right now - click to investigate
                  {dimLive && ' · feed paused, reconnecting…'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TrafficShareByIntersection
                  intersections={intersections}
                  liveCountByIntersection={liveCountByIntersection}
                />
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2 flex h-full">
            {warrantedTotal > 0 ? (
              <NeedsActionCard
                deploy={deployActions}
                escalate={escalateActions}
                later={laterActions}
                currentChunkName={currentChunk.name}
                nowMs={now.getTime()}
              />
            ) : (
              <AllClearPanel
                totalIntersections={intersections.length}
                analysedCount={analysedCount}
                lastAnalysedAt={lastAnalysedAt}
              />
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : intersections.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <div className="rounded-full bg-muted p-5">
            <WifiOff className="size-8 text-muted-foreground opacity-50" />
          </div>
          <div>
            <p className="font-medium">No intersections yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Use the setup wizard to connect cameras and start monitoring traffic.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => onOpenWizard('welcome')}>
              <Rocket className="size-4 mr-2" />
              Get Started
            </Button>
          </div>
        </div>
      ) : viewMode === 'map' ? (
        <div className={cn('transition-opacity', dimLive && 'opacity-60')}>
          <DensityMap
            intersections={intersections}
            sseData={sseData}
            onOpenSettings={setSettingsTarget}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
          {intersections.map(inter => (
            <IntersectionCard
              key={inter.id}
              inter={inter}
              cameras={cameras.filter(c => c.intersection_id === inter.id)}
              streets={streets.filter(s => s.intersection_id === inter.id)}
              rec={recs.get(inter.id)}
              liveCount={liveCountByIntersection[inter.id] ?? 0}
              dailyStats={dailyByInter.get(inter.id)}
              onRefresh={load}
              onOpenSettings={setSettingsTarget}
            />
          ))}
        </div>
      )}

      <SettingsSheet
        inter={settingsTarget}
        streets={streets.filter(s => s.intersection_id === settingsTarget?.id)}
        cameras={cameras.filter(c => c.intersection_id === settingsTarget?.id)}
        rec={settingsTarget ? recs.get(settingsTarget.id) : undefined}
        open={settingsTarget !== null}
        onClose={() => setSettingsTarget(null)}
        onRefresh={load}
      />

    </div>
  );
}
