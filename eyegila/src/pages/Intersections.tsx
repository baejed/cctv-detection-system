import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { cctvsApi } from '@/services/cctvs';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection, Street, CCTV, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { SettingsSheet } from '@/components/IntersectionSettingsSheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Plus, Settings2, WifiOff, RefreshCw, Wifi,
  Loader2, TrendingUp, AlertTriangle,
  Camera, Rocket, LayoutGrid, Map as MapIcon, MapPin, MonitorPlay,
  Wrench, ArrowRight,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';

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

// ── Camera snapshot grid ─────────────────────────────────────────────────────

function CameraGrid({ cameras }: { cameras: CCTV[] }) {
  const shown = cameras.slice(0, 4);
  const extra = Math.max(0, cameras.length - 4);

  if (cameras.length === 0) {
    return (
      <div className="aspect-video rounded-lg bg-muted/20 border border-dashed border-border flex items-center justify-center">
        <div className="flex flex-col items-center gap-1.5 opacity-40">
          <Camera className="size-5" />
          <span className="text-xs">No cameras</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'grid gap-px rounded-lg overflow-hidden bg-border',
      shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
    )}>
      {shown.map((cam, idx) => {
        const isLast   = idx === shown.length - 1 && extra > 0;
        const isOnline = cam.status === 'online';
        return (
          <Link
            key={cam.id}
            to={`/intersections/${cam.intersection_id}/cameras/${cam.id}`}
            className="relative group bg-black block"
            style={{ aspectRatio: shown.length === 1 ? '16/9' : '3/2' }}
          >
            {isOnline ? (
              <img
                src={cctvsApi.snapshotUrl(cam.id)}
                alt={cam.name}
                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                {cam.status === 'reconnecting'
                  ? <RefreshCw className="size-4 text-amber-400/60 animate-spin" />
                  : <WifiOff className="size-4 text-muted-foreground/30" />}
                <span className="text-[9px] text-muted-foreground/40">
                  {cam.status === 'reconnecting' ? 'reconnecting' : 'offline'}
                </span>
              </div>
            )}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <span className="text-[10px] text-white font-medium bg-black/60 px-2 py-0.5 rounded">
                Draw regions
              </span>
            </div>
            {isLast && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center pointer-events-none">
                <span className="text-white text-sm font-semibold">+{extra}</span>
              </div>
            )}
            <div className="absolute bottom-1 left-1.5 flex items-center gap-1 pointer-events-none">
              <span className={cn('size-1.5 rounded-full shrink-0',
                cam.status === 'online'       ? 'bg-emerald-400' :
                cam.status === 'reconnecting' ? 'bg-amber-400'   : 'bg-red-400',
              )} />
              <span className="text-[9px] text-white/70 leading-none truncate max-w-[4rem]">{cam.name}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
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
  onRefresh: () => void;
  onOpenSettings: (inter: Intersection) => void;
}

function IntersectionCard({ inter, cameras, rec, streets, liveCount, onRefresh, onOpenSettings }: CardProps) {
  const [generating, setGenerating] = useState(false);
  const bucket = rec ? statusBucket(rec) : null;

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

  return (
    <div data-testid="intersection-card" data-intersection-id={inter.id} className="rounded-xl border border-border bg-card flex flex-col gap-0 overflow-hidden h-full">
      {/* Header strip - coloured by warrant status */}
      <div className={cn(
        'h-1',
        bucket === 'warranted'     && 'bg-emerald-500',
        bucket === 'borderline'    && 'bg-amber-400',
        bucket === 'not_warranted' && 'bg-muted',
        (bucket === 'no_data' || !bucket) && 'bg-muted/40',
      )} />

      <div className="p-5 flex flex-col gap-4 flex-1">
        {/* Top row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <Link to={`/intersections/${inter.id}`} className="font-semibold text-base leading-tight truncate hover:underline underline-offset-2">{inter.name}</Link>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="text-[10px]">
                {inter.signal_status.replace('_', ' ')}
              </Badge>
              <WarrantBadge rec={rec} />
            </div>
          </div>
          <button
            onClick={() => onOpenSettings(inter)}
            className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={`Settings for ${inter.name}`}
          >
            <Settings2 className="size-4" />
          </button>
        </div>

        {/* Camera grid */}
        <CameraGrid cameras={cameras} />
        <div className="flex items-center justify-between -mt-2">
          {cameras.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {cameras.filter(c => c.status === 'online').length}/{cameras.length} online · click to draw regions
            </p>
          )}
          {liveCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium ml-auto">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              {liveCount} detected
            </span>
          )}
        </div>

        {/* Timing summary - only when warranted and timing exists */}
        {bucket === 'warranted' && rec?.timing_cycle && (
          <div className="rounded-lg bg-muted/40 px-3 py-2 flex items-center gap-2">
            <TrendingUp className="size-3.5 text-emerald-500 shrink-0" />
            <p className="text-xs">
              Recommended <span className="font-semibold">{rec.timing_cycle}s cycle</span>
              {rec.timing_chunk && (
                <span className="text-muted-foreground"> · peak {rec.timing_chunk}</span>
              )}
            </p>
          </div>
        )}

        {/* No streets warning */}
        {streets.length === 0 && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" />
            No approach directions set - open settings to configure
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap mt-auto">
          <Link to={`/intersections/${inter.id}`}>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
              <MonitorPlay className="size-3" />
              Live
            </Button>
          </Link>
          <Link to={`/intersections/${inter.id}/timing`}>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
              <TrendingUp className="size-3" />
              Signal Timing
            </Button>
          </Link>

          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            data-testid="btn-run-analysis"
            onClick={generate}
            disabled={generating}
          >
            {generating
              ? <Loader2 className="size-3 animate-spin" />
              : <RefreshCw className="size-3" />}
            {generating ? 'Analysing…' : 'Run analysis'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Hero stats ────────────────────────────────────────────────────────────────

const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#ec4899', '#14b8a6'];

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

  if (data.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
        <p className="text-xs font-medium text-muted-foreground">Traffic share by intersection</p>
        <p className="text-[11px] text-muted-foreground/70">awaiting live data</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Traffic share by intersection</p>
        <p className="text-[10px] text-muted-foreground tabular-nums">total {total.toLocaleString()}</p>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={32}
              outerRadius={64}
              paddingAngle={1}
              isAnimationActive={false}
            >
              {data.map((entry, i) => (
                <Cell key={entry.id} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, _name, item) => [
                `${value.toLocaleString()} (${Math.round((value / total) * 100)}%)`,
                item?.payload?.name,
              ]}
              contentStyle={{ fontSize: 11, padding: '4px 8px' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {data.slice(0, 6).map((d, i) => (
          <span key={d.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="max-w-[7rem] truncate">{d.name}</span>
            <strong className="font-semibold text-foreground tabular-nums">{d.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function IntersectionsPage() {
  const { sseData, onOpenWizard } = useOutletContext<{ sseData: AggregationRow[] | null; sseStatus: SSEStatus; onOpenWizard: (step?: string) => void }>();

  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [streets, setStreets]             = useState<Street[]>([]);
  const [cameras, setCameras]             = useState<CCTV[]>([]);
  const [recs, setRecs]                   = useState<Map<number, RecommendationResponse>>(new Map());
  const [loading, setLoading]             = useState(true);

  const liveCountByIntersection = useMemo(() => {
    const m: Record<number, number> = {};
    for (const row of sseData ?? []) {
      m[row.intersection_id] = (m[row.intersection_id] ?? 0) + row.count;
    }
    return m;
  }, [sseData]);

  const needsAction = useMemo(() => {
    const items: { inter: Intersection; rec: RecommendationResponse; reason: string }[] = [];
    for (const inter of intersections) {
      const rec = recs.get(inter.id);
      if (!rec || !rec.recommended) continue;
      const signalized = inter.signal_status !== 'unsignalized';
      const reason = signalized
        ? (rec.timing_cycle != null ? `Re-time to ${rec.timing_cycle}s cycle` : 'Re-timing recommended')
        : 'Install signal';
      items.push({ inter, rec, reason });
    }
    items.sort((a, b) => (b.rec.recommended_confidence ?? 0) - (a.rec.recommended_confidence ?? 0));
    return items.slice(0, 5);
  }, [intersections, recs]);

  const heroStats = useMemo(() => {
    const camOnline       = cameras.filter(c => c.status === 'online').length;
    const camReconnecting = cameras.filter(c => c.status === 'reconnecting').length;
    const camOffline      = cameras.filter(c => c.status === 'offline').length;
    const activeIntersections = Object.keys(liveCountByIntersection).length;
    return { camOnline, camReconnecting, camOffline, activeIntersections };
  }, [cameras, liveCountByIntersection]);

  const [viewMode, setViewMode]               = useState<'grid' | 'map'>('grid');
  const [generatingAll, setGeneratingAll]     = useState(false);
  const [settingsTarget, setSettingsTarget]   = useState<Intersection | null>(null);

  async function runAllAnalyses() {
    setGeneratingAll(true);
    try {
      const results = await recommendationsApi.generateAll();
      setRecs(new Map(results.map(r => [r.intersection_id, r])));
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
      const [ints, strs, cams, recList] = await Promise.all([
        intersectionsApi.list(),
        streetsApi.list(),
        cctvsApi.list(),
        recommendationsApi.list().catch(() => []),
      ]);
      setIntersections(ints);
      setStreets(strs);
      setCameras(cams);
      setRecs(new Map(recList.map(r => [r.intersection_id, r])));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Intersections</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {intersections.length} intersection{intersections.length !== 1 ? 's' : ''} monitored
          </p>
        </div>
        <div className="flex items-center gap-2">
          {intersections.length > 0 && (
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                data-testid="btn-view-grid"
                onClick={() => setViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                aria-label="Grid view"
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors',
                  viewMode === 'grid' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="size-3" />
                Grid
              </button>
              <button
                type="button"
                data-testid="btn-view-map"
                onClick={() => setViewMode('map')}
                aria-pressed={viewMode === 'map'}
                aria-label="Map view"
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors border-l border-border',
                  viewMode === 'map' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <MapIcon className="size-3" />
                Map
              </button>
            </div>
          )}
          {intersections.length > 0 && (
            <Button
              data-testid="btn-run-all-analyses"
              variant="outline"
              onClick={runAllAnalyses}
              disabled={generatingAll}
            >
              {generatingAll
                ? <Loader2 className="size-4 mr-2 animate-spin" />
                : <RefreshCw className="size-4 mr-2" />}
              {generatingAll ? 'Analysing…' : 'Run all analyses'}
            </Button>
          )}
          <Button data-testid="btn-add-intersection" onClick={() => onOpenWizard('discover')}>
            <Plus className="size-4 mr-2" />
            Set up intersection
          </Button>
        </div>
      </div>

      {/* Hero stats - visible once data loads */}
      {!loading && intersections.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardContent className="p-4">
              <TrafficShareByIntersection
                intersections={intersections}
                liveCountByIntersection={liveCountByIntersection}
              />
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-2">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Cameras</p>
                  <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                    {heroStats.camOnline}
                    <span className="text-base font-medium text-muted-foreground">/{cameras.length}</span>
                  </p>
                </div>
                <div className={cn('rounded-lg p-2', heroStats.camOffline > 0 ? 'bg-red-100' : 'bg-emerald-100')}>
                  <Camera className={cn('size-4', heroStats.camOffline > 0 ? 'text-red-600' : 'text-emerald-700')} />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2.5 text-[10px]">
                <span className="flex items-center gap-1 text-emerald-700">
                  <Wifi className="size-2.5" /> {heroStats.camOnline} online
                </span>
                {heroStats.camReconnecting > 0 && (
                  <span className="flex items-center gap-1 text-amber-600">
                    <RefreshCw className="size-2.5" /> {heroStats.camReconnecting}
                  </span>
                )}
                {heroStats.camOffline > 0 && (
                  <span className="flex items-center gap-1 font-semibold text-red-500">
                    <WifiOff className="size-2.5" /> {heroStats.camOffline} offline
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Intersections</p>
                  <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                    {heroStats.activeIntersections}
                    <span className="text-base font-medium text-muted-foreground">/{intersections.length}</span>
                  </p>
                </div>
                <div className="rounded-lg bg-violet-100 p-2">
                  <MapPin className="size-4 text-violet-700" />
                </div>
              </div>
              <p className="mt-3 text-[10px] text-muted-foreground">
                {heroStats.activeIntersections > 0 ? `${heroStats.activeIntersections} with live data` : 'awaiting live data'}
              </p>
            </CardContent>
          </Card>
          </div>
        </div>
      )}

      {!loading && needsAction.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="size-7 rounded-md bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
              <Wrench className="size-3.5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Needs action</h2>
              <p className="text-[11px] text-muted-foreground">
                Intersections with a warranted timing or signal change
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            {needsAction.map(({ inter, rec, reason }) => (
              <Link
                key={inter.id}
                to={`/intersections/${inter.id}`}
                className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
              >
                <span className="flex-1 font-medium truncate">{inter.name}</span>
                <span className="text-muted-foreground truncate">{reason}</span>
                {rec.recommended_confidence != null && (
                  <span className="font-mono tabular-nums text-muted-foreground/80 w-10 text-right">
                    {Math.round(rec.recommended_confidence * 100)}%
                  </span>
                )}
                <ArrowRight className="size-3 text-muted-foreground shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-52" />)}
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
        <DensityMap
          intersections={intersections}
          sseData={sseData}
          onOpenSettings={setSettingsTarget}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {intersections.map(inter => (
            <IntersectionCard
              key={inter.id}
              inter={inter}
              cameras={cameras.filter(c => c.intersection_id === inter.id)}
              streets={streets.filter(s => s.intersection_id === inter.id)}
              rec={recs.get(inter.id)}
              liveCount={liveCountByIntersection[inter.id] ?? 0}
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
