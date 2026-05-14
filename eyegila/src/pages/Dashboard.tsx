import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SetupGuide } from '@/components/SetupGuide';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { aggregationApi } from '@/services/aggregation';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import type { AggregationRow, CCTV, Street, Intersection } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import {
  Wifi, WifiOff, RefreshCw, Camera, Radio,
  ExternalLink, Lightbulb, X, MapPin, TrendingUp, Users,
  LayoutGrid, Map as MapIcon, ArrowDown, ArrowUp,
} from 'lucide-react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { cn } from '@/lib/utils';

interface OutletCtx { sseData: AggregationRow[] | null; sseStatus: SSEStatus }

const TYPE_HEX: Record<string, string> = {
  car:        '#16a34a',
  motorcycle: '#0369a1',
  tricycle:   '#d97706',
  truck:      '#dc2626',
  pedicab:    '#7c3aed',
  pedestrian: '#0891b2',
  person:     '#0891b2',
};

const PEDESTRIAN_TYPES = new Set(['pedestrian', 'person']);

type DensityLevel = 'none' | 'low' | 'moderate' | 'high' | 'critical';

function getDensityLevel(count: number): DensityLevel {
  if (count === 0) return 'none';
  if (count < 50) return 'low';
  if (count < 150) return 'moderate';
  if (count < 400) return 'high';
  return 'critical';
}

function getDensityLabel(count: number): string {
  if (count === 0) return 'No data';
  if (count < 50) return 'Low';
  if (count < 150) return 'Moderate';
  if (count < 400) return 'High';
  return 'Very High';
}

const DENSITY_BADGE: Record<DensityLevel, string> = {
  none:     'border-slate-200 text-slate-500 bg-slate-50',
  low:      'border-emerald-200 text-emerald-700 bg-emerald-50',
  moderate: 'border-amber-200 text-amber-700 bg-amber-50',
  high:     'border-orange-200 text-orange-700 bg-orange-50',
  critical: 'border-red-200 text-red-700 bg-red-50',
};

// ── Map helpers ──────────────────────────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [7.4478, 125.8075];

function densityColor(count: number): string {
  if (count === 0)  return '#6b7280';
  if (count < 50)   return '#22c55e';
  if (count < 150)  return '#f59e0b';
  if (count < 400)  return '#f97316';
  return                   '#ef4444';
}

function MapAutoCenter({ intersections }: { intersections: Intersection[] }) {
  const map  = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const first = intersections.find(i => i.latitude && i.longitude);
    if (first) { map.setView([first.latitude, first.longitude], 14); done.current = true; }
  }, [intersections, map]);
  return null;
}

interface DashboardMapProps {
  intersections: Intersection[];
  sseData:       AggregationRow[] | null;
  historyData:   AggregationRow[];
  selectedId:    number | null;
  onSelect:      (id: number) => void;
}

function DashboardMap({ intersections, sseData, historyData, selectedId, onSelect }: DashboardMapProps) {
  const source = (sseData && sseData.length > 0) ? sseData : historyData;

  const byInter = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of source) m.set(r.intersection_id, (m.get(r.intersection_id) ?? 0) + r.count);
    return m;
  }, [source]);

  const maxTotal  = Math.max(1, ...byInter.values());
  const mappable  = intersections.filter(i => i.latitude && i.longitude);
  const first     = mappable[0];
  const center: [number, number] = first ? [first.latitude, first.longitude] : DEFAULT_CENTER;

  return (
    <div className="flex flex-col gap-2">
      {/* Legend */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {(['No data:#6b7280', 'Low:#22c55e', 'Moderate:#f59e0b', 'High:#f97316', 'Very High:#ef4444']).map(entry => {
          const [label, color] = entry.split(':');
          return (
            <span key={label} className="flex items-center gap-1">
              <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />
              {label}
            </span>
          );
        })}
        <span className="ml-auto opacity-60">
          {sseData && sseData.length > 0 ? 'live' : 'last hour'}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border" style={{ height: 420, isolation: 'isolate' }}>
        <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <MapAutoCenter intersections={intersections} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {mappable.length === 0 && (
            <CircleMarker center={DEFAULT_CENTER} radius={10}
              pathOptions={{ color: '#6b7280', fillColor: '#6b7280', fillOpacity: 0.4 }}>
              <Popup><p className="text-xs">No intersections with coordinates yet.</p></Popup>
            </CircleMarker>
          )}
          {mappable.map(inter => {
            const total      = byInter.get(inter.id) ?? 0;
            const color      = densityColor(total);
            const isSelected = selectedId === inter.id;
            const radius     = 12 + Math.round(20 * (total / maxTotal));
            return (
              <CircleMarker
                key={inter.id}
                center={[inter.latitude, inter.longitude]}
                radius={isSelected ? radius + 4 : radius}
                pathOptions={{
                  color:       isSelected ? '#fff' : color,
                  fillColor:   color,
                  fillOpacity: isSelected ? 0.9 : 0.6,
                  weight:      isSelected ? 3 : 1.5,
                }}
                eventHandlers={{ click: () => onSelect(inter.id) }}
              >
                <Popup>
                  <div className="text-xs min-w-[130px]">
                    <p className="font-semibold mb-1">{inter.name}</p>
                    <p style={{ color }}>{getDensityLabel(total)} · {total} detected</p>
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

// ─────────────────────────────────────────────────────────────────────────────

interface StreetEntry {
  name: string;
  types: Record<string, number>;
  directions: { inbound: number; outbound: number; unknown: number };
}
interface InterEntry  { name: string; streets: Map<number, StreetEntry>; total: number }

function groupData(rows: AggregationRow[], streetMap: Map<number, string>): Map<number, InterEntry> {
  const map = new Map<number, InterEntry>();
  for (const r of rows) {
    if (!map.has(r.intersection_id))
      map.set(r.intersection_id, { name: r.intersection_name, streets: new Map(), total: 0 });
    const inter = map.get(r.intersection_id)!;
    inter.total += r.count;
    // null street_id = unregioned camera; counts toward intersection total only
    if (r.street_id === null) continue;
    if (!inter.streets.has(r.street_id))
      inter.streets.set(r.street_id, {
        name: streetMap.get(r.street_id) ?? `Street ${r.street_id}`,
        types: {},
        directions: { inbound: 0, outbound: 0, unknown: 0 },
      });
    const s = inter.streets.get(r.street_id)!;
    s.types[r.object_type] = (s.types[r.object_type] ?? 0) + r.count;
    const dir = r.direction ?? 'unknown';
    s.directions[dir as keyof typeof s.directions] = (s.directions[dir as keyof typeof s.directions] ?? 0) + r.count;
  }
  return map;
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-xs font-medium',
      status === 'online'       && 'text-emerald-600',
      status === 'reconnecting' && 'text-amber-600',
      status === 'offline'      && 'text-red-600',
    )}>
      {status === 'online'       && <span className="size-1.5 rounded-full bg-emerald-500 inline-block" aria-hidden="true" />}
      {status === 'reconnecting' && <RefreshCw className="size-2.5 animate-spin" aria-hidden="true" />}
      {status === 'offline'      && <WifiOff className="size-2.5" aria-hidden="true" />}
      {status}
    </span>
  );
}

export function DashboardPage() {
  const { sseData, sseStatus } = useOutletContext<OutletCtx>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [cctvs, setCctvs]                 = useState<CCTV[]>([]);
  const [streets, setStreets]             = useState<Street[]>([]);
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [historyData, setHistoryData]     = useState<AggregationRow[]>([]);
  const [loading, setLoading]             = useState(true);
  const [viewMode, setViewMode]           = useState<'grid' | 'map'>('grid');
  const [recsById, setRecsById]           = useState<Map<number, RecommendationResponse>>(new Map());

  const selectedId = searchParams.get('intersection')
    ? Number(searchParams.get('intersection'))
    : null;

  function selectIntersection(id: number) {
    setSearchParams(selectedId === id ? {} : { intersection: String(id) });
  }

  useEffect(() => {
    const now    = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    Promise.all([
      cctvsApi.list(),
      streetsApi.list(),
      intersectionsApi.list(),
      aggregationApi.history({ start: oneHourAgo.toISOString(), end: now.toISOString(), bucket: 'hour' }),
    ])
      .then(([c, s, i, h]) => { setCctvs(c); setStreets(s); setIntersections(i); setHistoryData(h); })
      .catch(console.error)
      .finally(() => setLoading(false));

    const t = setInterval(() => cctvsApi.list().then(setCctvs).catch(console.error), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi.list()
      .then(recs => {
        if (cancelled) return;
        setRecsById(new Map(recs.map(r => [r.intersection_id, r])));
      })
      .catch(() => { /* silent — Dashboard still works without recs */ });
    return () => { cancelled = true; };
  }, []);

  const streetMap = useMemo(() => new Map(streets.map(s => [s.id, s.name])), [streets]);
  const grouped   = useMemo(() => groupData(sseData ?? [], streetMap), [sseData, streetMap]);

  const intersectionMap = useMemo(() => new Map(intersections.map(i => [i.id, i.name])), [intersections]);


  // ── Global aggregates
  const globalTypes: Record<string, number> = {};
  let totalVehicles = 0, totalPedestrians = 0;
  for (const r of sseData ?? []) {
    globalTypes[r.object_type] = (globalTypes[r.object_type] ?? 0) + r.count;
    if (PEDESTRIAN_TYPES.has(r.object_type)) totalPedestrians += r.count;
    else totalVehicles += r.count;
  }

  // ── Per-intersection live counts
  const byIntersection = useMemo(() => {
    const m = new Map<number, { vehicles: number; pedestrians: number; total: number; types: Record<string, number> }>();
    for (const r of sseData ?? []) {
      const e = m.get(r.intersection_id) ?? { vehicles: 0, pedestrians: 0, total: 0, types: {} };
      if (PEDESTRIAN_TYPES.has(r.object_type)) e.pedestrians += r.count;
      else e.vehicles += r.count;
      e.total += r.count;
      e.types[r.object_type] = (e.types[r.object_type] ?? 0) + r.count;
      m.set(r.intersection_id, e);
    }
    return m;
  }, [sseData]);

  // ── Camera summary
  let camOnline = 0, camReconnecting = 0, camOffline = 0;
  for (const c of cctvs) {
    if (c.status === 'online') camOnline++;
    else if (c.status === 'reconnecting') camReconnecting++;
    else if (c.status === 'offline') camOffline++;
  }

  // ── Global chart data
  const typeChartData = Object.entries(globalTypes)
    .map(([type, count]) => ({ label: type[0].toUpperCase() + type.slice(1), count, type }))
    .sort((a, b) => b.count - a.count);

  const interBarData = [...grouped.entries()]
    .map(([, inter]) => ({ name: inter.name, count: inter.total }))
    .sort((a, b) => b.count - a.count);

  // ── Focused intersection data
  const focusedInter    = selectedId != null ? grouped.get(selectedId) : null;
  const focusedCameras  = selectedId != null
    ? cctvs.filter(c => c.intersection_id === selectedId)
    : [];
  const selectedInter   = intersections.find(i => i.id === selectedId);

  const focusedTypeChart = useMemo(() => {
    if (selectedId == null || !sseData) return [];
    const types: Record<string, number> = {};
    for (const r of sseData) {
      if (r.intersection_id === selectedId)
        types[r.object_type] = (types[r.object_type] ?? 0) + r.count;
    }
    return Object.entries(types)
      .map(([type, count]) => ({ label: type[0].toUpperCase() + type.slice(1), count, type }))
      .sort((a, b) => b.count - a.count);
  }, [sseData, selectedId]);

  return (
    <div className="flex flex-col gap-6">

      {/* ── Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-green-950">Live Dashboard</h1>
          {selectedInter && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Focused on{' '}
              <span className="font-medium text-foreground">{selectedInter.name}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedId != null && (
            <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>
              <X className="size-3.5" aria-hidden="true" />
              Clear focus
            </Button>
          )}
          <div className={cn(
            'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border',
            sseStatus === 'connected'    && 'border-green-200 bg-green-50 text-green-700',
            sseStatus === 'connecting'   && 'border-amber-200 bg-amber-50 text-amber-700',
            sseStatus === 'disconnected' && 'border-red-200 bg-red-50 text-red-700',
          )}>
            <Radio className="size-3 sse-pulse" aria-hidden="true" />
            {sseStatus === 'connected' ? 'Live' : sseStatus === 'connecting' ? 'Connecting…' : 'Offline'}
          </div>
        </div>
      </div>

      {/* ── Setup guide (shown until dismissed or complete) */}
      <SetupGuide />

      {/* ── Hero stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Vehicles */}
        <Card className="col-span-1">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Vehicles</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none text-foreground">
                  {sseData ? totalVehicles.toLocaleString() : '-'}
                </p>
              </div>
              <div className="rounded-lg bg-green-100 p-2">
                <TrendingUp className="size-4 text-green-700" aria-hidden="true" />
              </div>
            </div>
            {typeChartData.filter(e => !PEDESTRIAN_TYPES.has(e.type)).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1">
                {typeChartData.filter(e => !PEDESTRIAN_TYPES.has(e.type)).slice(0, 3).map(e => (
                  <span key={e.type} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: TYPE_HEX[e.type] ?? '#16a34a' }} aria-hidden="true" />
                    {e.label} <strong className="font-semibold text-foreground">{e.count}</strong>
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pedestrians */}
        <Card className="col-span-1">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Pedestrians</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none text-foreground">
                  {sseData ? totalPedestrians.toLocaleString() : '-'}
                </p>
              </div>
              <div className="rounded-lg bg-cyan-100 p-2">
                <Users className="size-4 text-cyan-700" aria-hidden="true" />
              </div>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              {sseData && (totalVehicles + totalPedestrians) > 0
                ? `${Math.round((totalPedestrians / (totalVehicles + totalPedestrians)) * 100)}% of total`
                : 'awaiting data'}
            </p>
          </CardContent>
        </Card>

        {/* Camera health */}
        <Card className="col-span-1">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Cameras</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none text-foreground">
                  {camOnline}<span className="text-base font-medium text-muted-foreground">/{cctvs.length}</span>
                </p>
              </div>
              <div className={cn(
                'rounded-lg p-2',
                camOffline > 0 ? 'bg-red-100' : 'bg-emerald-100',
              )}>
                <Camera className={cn('size-4', camOffline > 0 ? 'text-red-600' : 'text-emerald-700')} aria-hidden="true" />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2.5 text-[10px]">
              <span className="flex items-center gap-1 text-emerald-700">
                <Wifi className="size-2.5" aria-hidden="true" /> {camOnline} online
              </span>
              {camReconnecting > 0 && (
                <span className="flex items-center gap-1 text-amber-600">
                  <RefreshCw className="size-2.5" aria-hidden="true" /> {camReconnecting}
                </span>
              )}
              {camOffline > 0 && (
                <span className="flex items-center gap-1 font-semibold text-red-500">
                  <WifiOff className="size-2.5" aria-hidden="true" /> {camOffline} offline
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Active intersections */}
        <Card className="col-span-1">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Intersections</p>
                <p className="mt-1 text-3xl font-black tabular-nums leading-none text-foreground">
                  {byIntersection.size}<span className="text-base font-medium text-muted-foreground">/{intersections.length}</span>
                </p>
              </div>
              <div className="rounded-lg bg-violet-100 p-2">
                <MapPin className="size-4 text-violet-700" aria-hidden="true" />
              </div>
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              {byIntersection.size > 0 ? `${byIntersection.size} with live data` : 'awaiting data'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Intersection grid / map */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Intersections
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {intersections.length} total
            </span>
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                aria-label="Grid view"
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors',
                  viewMode === 'grid'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="size-3" aria-hidden="true" />
                Grid
              </button>
              <button
                type="button"
                onClick={() => setViewMode('map')}
                aria-pressed={viewMode === 'map'}
                aria-label="Map view"
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors border-l border-border',
                  viewMode === 'map'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <MapIcon className="size-3" aria-hidden="true" />
                Map
              </button>
            </div>
          </div>
        </div>

        {viewMode === 'map' ? (
          loading ? (
            <Skeleton className="h-[452px] w-full rounded-xl" />
          ) : (
            <DashboardMap
              intersections={intersections}
              sseData={sseData}
              historyData={historyData}
              selectedId={selectedId}
              onSelect={selectIntersection}
            />
          )
        ) : loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : intersections.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground rounded-xl border border-dashed border-border">
            <MapPin className="size-7 opacity-20" aria-hidden="true" />
            <p className="text-sm">No intersections configured</p>
            <Link to="/intersections">
              <Button variant="outline" size="sm">Add intersection</Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {intersections.map(inter => {
              const counts      = byIntersection.get(inter.id) ?? { vehicles: 0, pedestrians: 0, total: 0, types: {} };
              const level       = getDensityLevel(counts.total);
              const isSelected  = selectedId === inter.id;
              const typeSorted  = Object.entries(counts.types).sort(([, a], [, b]) => b - a);
              const interCams   = cctvs.filter(c => c.intersection_id === inter.id);
              const offlineCams = interCams.filter(c => c.status === 'offline').length;
              return (
                <button
                  key={inter.id}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`Focus ${inter.name} - ${getDensityLabel(counts.total)}`}
                  onClick={() => selectIntersection(inter.id)}
                  className={cn(
                    'group flex flex-col rounded-xl border bg-card text-left transition-all hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring overflow-hidden',
                    isSelected
                      ? 'border-green-400 ring-2 ring-green-400/25 shadow-sm'
                      : 'border-border hover:border-green-200',
                  )}
                >
                  {/* 2×2 camera grid */}
                  <div className="relative w-full aspect-video overflow-hidden bg-black">
                    {/* 2×2 grid with 1px black gaps as dividers */}
                    <div className="grid grid-cols-2 grid-rows-2 w-full h-full gap-px bg-white/20">
                      {Array.from({ length: 4 }).map((_, slot) => {
                        const cam      = interCams[slot];
                        const isExtra  = slot === 3 && interCams.length > 4;
                        const extraCnt = interCams.length - 3;
                        return (
                          <div key={slot} className="relative overflow-hidden bg-black">
                            {cam ? (
                              <img
                                src={cctvsApi.snapshotUrl(cam.id)}
                                alt=""
                                loading="lazy"
                                className="w-full h-full object-cover"
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Camera className="size-3 text-white/10" aria-hidden="true" />
                              </div>
                            )}
                            {isExtra && (
                              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <span className="text-white text-xs font-bold">+{extraCnt}</span>
                              </div>
                            )}
                            {cam && cam.status === 'offline' && (
                              <div className="absolute inset-0 bg-red-900/40" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                    {/* Density badge */}
                    <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
                      <Badge
                        variant="outline"
                        className={cn('text-[10px] px-1.5 py-0 backdrop-blur-sm bg-black/60 border-white/20', DENSITY_BADGE[level])}
                      >
                        {getDensityLabel(counts.total)}
                      </Badge>
                      {(() => {
                        const rec = recsById.get(inter.id);
                        if (!rec) return null;
                        const b = statusBucket(rec);
                        return (
                          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 backdrop-blur-sm bg-black/60 border-white/20', BUCKET_BADGE_CLASS[b])}>
                            {BUCKET_LABEL[b]}
                          </Badge>
                        );
                      })()}
                    </div>
                    {/* Vehicles + pedestrians */}
                    <div className="absolute bottom-1.5 left-2 right-2 flex items-end justify-between">
                      <div className="flex items-center gap-2">
                        <div>
                          <span className="text-base font-black tabular-nums leading-none text-green-400 drop-shadow">
                            {sseData ? counts.vehicles : '-'}
                          </span>
                          <span className="block text-[9px] text-white/50 leading-none mt-0.5">vehicles</span>
                        </div>
                        <div className="w-px h-5 bg-white/20 shrink-0" />
                        <div>
                          <span className="text-base font-black tabular-nums leading-none text-cyan-400 drop-shadow">
                            {sseData ? counts.pedestrians : '-'}
                          </span>
                          <span className="block text-[9px] text-white/50 leading-none mt-0.5">pedestrians</span>
                        </div>
                      </div>
                      {offlineCams > 0 && (
                        <span className="text-[9px] font-semibold text-red-400">{offlineCams} offline</span>
                      )}
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="flex flex-col gap-2 p-3">
                    {/* Name */}
                    <span className="text-xs font-semibold text-foreground leading-snug line-clamp-2">
                      {inter.name}
                    </span>

                    {/* Type proportion bar */}
                    {typeSorted.length > 0 && counts.total > 0 ? (
                      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-100">
                        {typeSorted.map(([type, count]) => (
                          <div
                            key={type}
                            style={{ width: `${(count / counts.total) * 100}%`, backgroundColor: TYPE_HEX[type] ?? '#16a34a' }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="h-1.5 rounded-full bg-slate-100" />
                    )}

                    {/* Camera count */}
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Camera className="size-2.5" aria-hidden="true" />
                      {interCams.length} cam{interCams.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── No SSE data */}
      {!sseData && !loading && (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <Radio className="size-7 opacity-20" aria-hidden="true" />
          <p className="text-sm">
            {sseStatus === 'connected'    ? 'Waiting for data - arrives every 5 s'
             : sseStatus === 'connecting' ? 'Establishing connection…'
             : 'SSE disconnected - retrying…'}
          </p>
        </div>
      )}

      {/* ── Focused intersection panel */}
      {selectedId != null && (
        <div className="flex flex-col gap-4">
          <Separator />

          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">

            {/* Street breakdown */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-baseline justify-between">
                  <CardTitle className="text-base font-semibold text-green-950">
                    {selectedInter?.name ?? '-'}
                  </CardTitle>
                  <span className="text-2xl font-black tabular-nums text-green-700 ml-4 shrink-0">
                    {focusedInter?.total ?? 0}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                {!focusedInter ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">
                    No live data for this intersection yet.
                  </p>
                ) : (
                  <div className="flex flex-col divide-y divide-border/60">
                    {[...focusedInter.streets.entries()]
                      .sort(([, a], [, b]) =>
                        Object.values(b.types).reduce((x, y) => x + y, 0) -
                        Object.values(a.types).reduce((x, y) => x + y, 0)
                      )
                      .map(([streetId, street]) => {
                        const streetTotal = Object.values(street.types).reduce((a, b) => a + b, 0);
                        const sorted = Object.entries(street.types).sort(([, a], [, b]) => b - a);
                        return (
                          <div key={streetId} className="py-3 first:pt-0 last:pb-0">
                            <div className="flex items-baseline justify-between mb-1.5">
                              <span className="text-sm font-medium text-slate-800">{street.name}</span>
                              <span className="text-sm font-bold tabular-nums text-green-700 ml-4 shrink-0">{streetTotal}</span>
                            </div>
                            <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
                              {sorted.map(([type, count]) => (
                                <div
                                  key={type}
                                  style={{ width: `${(count / streetTotal) * 100}%`, backgroundColor: TYPE_HEX[type] ?? '#16a34a' }}
                                />
                              ))}
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-x-3">
                              {sorted.slice(0, 5).map(([type, count]) => (
                                <span key={type} className="text-[10px] text-slate-400">
                                  {type} <strong className="text-slate-700 font-semibold">{count}</strong>
                                </span>
                              ))}
                            </div>
                            {(street.directions.inbound > 0 || street.directions.outbound > 0) && (
                              <div className="mt-1.5 flex items-center gap-3">
                                {street.directions.inbound > 0 && (
                                  <span className="flex items-center gap-1 text-[10px] text-slate-400">
                                    <ArrowDown className="size-2.5 text-green-500" aria-hidden="true" />
                                    inbound <strong className="text-slate-700 font-semibold">{street.directions.inbound}</strong>
                                  </span>
                                )}
                                {street.directions.outbound > 0 && (
                                  <span className="flex items-center gap-1 text-[10px] text-slate-400">
                                    <ArrowUp className="size-2.5 text-orange-500" aria-hidden="true" />
                                    outbound <strong className="text-slate-700 font-semibold">{street.directions.outbound}</strong>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Right column: scoped chart + warrant placeholder */}
            <div className="flex flex-col gap-4">
              {focusedTypeChart.length > 0 && (
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4">
                    <CardTitle className="text-xs font-semibold text-slate-700">Detection Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent className="px-2 pb-3">
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={focusedTypeChart} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={28} />
                        <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e2e8f0' }} cursor={{ fill: '#f1f5f9' }} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {focusedTypeChart.map(e => (
                            <Cell key={e.type} fill={TYPE_HEX[e.type] ?? '#16a34a'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Warrant summary - placeholder until analysis is run */}
              <Card className="border-dashed">
                <CardHeader className="pb-2 pt-4 px-4">
                  <div className="flex items-center gap-1.5">
                    <Lightbulb className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <CardTitle className="text-xs font-semibold text-slate-700">Signal Warrant</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 flex flex-col gap-3">
                  {(() => {
                    const rec = selectedInter ? recsById.get(selectedInter.id) : undefined;
                    const rows = [
                      { label: 'W1 - 8-Hour Volume',     met: rec?.warrant_1_met, conf: rec?.warrant_1_confidence },
                      { label: 'W2 - 4-Hour Volume',     met: rec?.warrant_2_met, conf: rec?.warrant_2_confidence },
                      { label: 'W4 - Pedestrian Volume', met: rec?.warrant_4_met, conf: rec?.warrant_4_confidence },
                    ];
                    return rows.map(r => (
                      <div key={r.label} className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">{r.label}</span>
                        {rec ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              r.met
                                ? 'border-emerald-500/40 text-emerald-700 bg-emerald-50'
                                : 'border-slate-200 text-slate-500',
                            )}
                          >
                            {r.met ? '✓' : '·'} {((r.conf ?? 0) * 100).toFixed(0)}%
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] border-slate-200 text-slate-400">—</Badge>
                        )}
                      </div>
                    ));
                  })()}
                  <Separator />
                  <Link
                    to="/recommendations"
                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {selectedInter && recsById.get(selectedInter.id) ? 'View details' : 'Run warrant analysis'}
                    <ExternalLink className="size-2.5" aria-hidden="true" />
                  </Link>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Camera management table */}
          <Card>
            <CardHeader className="pb-0 px-5 pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Camera className="size-3.5 text-slate-400" aria-hidden="true" />
                  <CardTitle className="text-sm font-semibold text-slate-700">
                    Cameras
                    <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                      - {selectedInter?.name}
                    </span>
                  </CardTitle>
                </div>
                <Link to="/cameras">
                  <Button variant="ghost" size="sm" className="text-xs h-7 gap-1">
                    Manage all
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {focusedCameras.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                  <Camera className="size-8 opacity-20" aria-hidden="true" />
                  <p className="text-xs">No cameras assigned to this intersection</p>
                  <Link to="/cameras">
                    <Button variant="outline" size="sm" className="mt-1">Add Camera</Button>
                  </Link>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-t">
                      <TableHead className="h-8 text-xs font-medium px-5">Camera</TableHead>
                      <TableHead className="h-8 text-xs font-medium">Status</TableHead>
                      <TableHead className="h-8 text-xs font-medium hidden md:table-cell">RTSP URL</TableHead>
                      <TableHead className="h-8 w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {focusedCameras.map(c => (
                      <TableRow key={c.id} className={cn(c.status === 'offline' && 'bg-red-50/30')}>
                        <TableCell className="font-medium py-2 px-5">{c.name}</TableCell>
                        <TableCell className="py-2"><StatusDot status={c.status} /></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground hidden md:table-cell py-2 max-w-[200px] truncate">
                          {c.rtsp_url}
                        </TableCell>
                        <TableCell className="py-2 pr-3">
                          <Link to={`/cameras/${c.id}`}>
                            <Button variant="ghost" size="icon" className="size-7" aria-label={`Open ${c.name} detail`}>
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Global view - only when no intersection focused */}
      {selectedId == null && sseData && (totalVehicles + totalPedestrians) > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: typeChartData.length > 0 && interBarData.length > 0 ? '3fr 2fr' : '1fr' }}>
          {typeChartData.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-slate-700">Detections by Type - Today</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-4">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={typeChartData} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={32} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {typeChartData.map(e => <Cell key={e.type} fill={TYPE_HEX[e.type] ?? '#16a34a'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
          {interBarData.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-slate-700">Volume by Intersection</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-4">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={interBarData} layout="vertical" barCategoryGap="30%" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} width={120} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }} cursor={{ fill: '#f1f5f9' }} />
                    <Bar dataKey="count" fill="#16a34a" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── All-camera health - only when no intersection focused */}
      {selectedId == null && (
        <Card>
          <CardHeader className="pb-0 px-5 pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="size-3.5 text-slate-400" aria-hidden="true" />
                <CardTitle className="text-sm font-semibold text-slate-700">Camera Health</CardTitle>
              </div>
              <Link to="/cameras">
                <Button variant="ghost" size="sm" className="text-xs h-7 gap-1">
                  Manage
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex flex-col gap-2 p-5">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-6 w-full" />)}
              </div>
            ) : cctvs.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">No cameras registered.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-t border-b">
                    <TableHead className="h-8 text-xs font-medium px-5">Camera</TableHead>
                    <TableHead className="h-8 text-xs font-medium">Status</TableHead>
                    <TableHead className="h-8 text-xs font-medium hidden md:table-cell">RTSP URL</TableHead>
                    <TableHead className="h-8 w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cctvs.map(c => (
                    <TableRow key={c.id} className={cn(c.status === 'offline' && 'bg-red-50/30')}>
                      <TableCell className="py-2 px-5">
                        <span className="font-medium text-sm">{c.name}</span>
                        {c.intersection_id && (
                          <span className="block text-[10px] text-muted-foreground">
                            {intersectionMap.get(c.intersection_id) ?? '-'}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-2"><StatusDot status={c.status} /></TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground hidden md:table-cell py-2">{c.rtsp_url}</TableCell>
                      <TableCell className="py-2 pr-3">
                        <Link to={`/cameras/${c.id}`}>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Open ${c.name} detail`}>
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
