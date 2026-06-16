import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { intersectionsApi, type DetectTimingResult } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { cctvsApi } from '@/services/cctvs';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection, Street, CCTV, SignalStatus, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { IntersectionSetupWizard } from '@/components/IntersectionSetupWizard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import {
  Plus, Settings2, Trash2, WifiOff, RefreshCw, Wifi,
  Loader2, TrendingUp, AlertTriangle, ScanSearch, ExternalLink,
  Camera, Rocket, LayoutGrid, Map as MapIcon, Users, MapPin, MonitorPlay,
} from 'lucide-react';
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

// ── Settings ──────────────────────────────────────────────────────────────────

const SIGNAL_STATUS_OPTIONS: { value: SignalStatus; label: string }[] = [
  { value: 'unsignalized', label: 'Unsignalized' },
  { value: 'fixed_time',   label: 'Fixed-time signal' },
  { value: 'actuated',     label: 'Actuated signal' },
];

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
        const isLast = idx === shown.length - 1 && extra > 0;
        return (
          <Link
            key={cam.id}
            to={`/cameras/${cam.id}`}
            className="relative group bg-black block"
            style={{ aspectRatio: shown.length === 1 ? '16/9' : '3/2' }}
          >
            <img
              src={cctvsApi.snapshotUrl(cam.id)}
              alt={cam.name}
              className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
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
    <div className="rounded-xl border border-border bg-card flex flex-col gap-0 overflow-hidden">
      {/* Header strip — coloured by warrant status */}
      <div className={cn(
        'h-1',
        bucket === 'warranted'     && 'bg-emerald-500',
        bucket === 'borderline'    && 'bg-amber-400',
        bucket === 'not_warranted' && 'bg-muted',
        (bucket === 'no_data' || !bucket) && 'bg-muted/40',
      )} />

      <div className="p-5 flex flex-col gap-4">
        {/* Top row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <h3 className="font-semibold text-base leading-tight truncate">{inter.name}</h3>
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

        {/* Timing summary — only when warranted and timing exists */}
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
            No approach directions set — open settings to configure
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/intersections/${inter.id}`}>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
              <MonitorPlay className="size-3" />
              Live
            </Button>
          </Link>
          <Link to={`/timing/${inter.id}`}>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
              <TrendingUp className="size-3" />
              Signal Timing
            </Button>
          </Link>

          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
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

// ── Settings sheet ───────────────────────────────────────────────────────────

interface SettingsSheetProps {
  inter: Intersection | null;
  streets: Street[];
  cameras: CCTV[];
  rec: import('@/services/recommendations').RecommendationResponse | undefined;
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

function SettingsSheet({ inter, streets, cameras, rec, open, onClose, onRefresh }: SettingsSheetProps) {
  const [name, setName]   = useState('');
  const [lat, setLat]     = useState('');
  const [lng, setLng]     = useState('');
  const [signalStatus, setSignalStatus] = useState<SignalStatus>('unsignalized');
  const [cycleLen, setCycleLen]         = useState('');
  const [saving, setSaving]             = useState(false);
  const [detectingTiming, setDetectingTiming] = useState(false);
  const [detectResult, setDetectResult]       = useState<DetectTimingResult | null>(null);
  const [stagingDirs, setStagingDirs]   = useState<Record<number, string>>({});
  const [newCamName, setNewCamName]   = useState('');
  const [newCamRtsp, setNewCamRtsp]   = useState('');
  const [addingCam, setAddingCam]     = useState(false);
  const [addingStreet, setAddingStreet] = useState(false);
  const [newStreetName, setNewStreetName] = useState('');
  const [newStreetDir, setNewStreetDir]   = useState<string>('unknown');

  useEffect(() => {
    if (inter) {
      setName(inter.name);
      setLat(String(inter.latitude ?? ''));
      setLng(String(inter.longitude ?? ''));
      setSignalStatus(inter.signal_status ?? 'unsignalized');
      setCycleLen(inter.existing_cycle_length != null ? String(inter.existing_cycle_length) : '');
      setDetectResult(null);
      setStagingDirs({});
    }
  }, [inter]);

  const hasUnsavedDirs = Object.keys(stagingDirs).length > 0;

  async function saveAll() {
    if (!inter || !name.trim()) return;
    setSaving(true);
    try {
      const dirUpdates = Object.entries(stagingDirs).map(([sid, dir]) =>
        streetsApi.update(Number(sid), { arm_direction: dir as Street['arm_direction'] })
      );
      await Promise.all([
        intersectionsApi.update(inter.id, { name: name.trim(), latitude: parseFloat(lat) || 0, longitude: parseFloat(lng) || 0 }),
        intersectionsApi.patchTiming(inter.id, {
          signal_status: signalStatus,
          existing_cycle_length: cycleLen ? parseInt(cycleLen) : null,
        }),
        ...dirUpdates,
      ]);
      setStagingDirs({});
      toast.success('Saved');
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function detect() {
    if (!inter) return;
    setDetectingTiming(true);
    try {
      const result = await intersectionsApi.detectTiming(inter.id);
      setDetectResult(result);
      if (result.estimated_cycle_s != null) {
        setCycleLen(String(result.estimated_cycle_s));
        toast.success(`Detected ~${result.estimated_cycle_s}s cycle`);
      } else {
        toast.info('Could not detect a cycle pattern');
      }
    } catch {
      toast.error('Detection failed');
    } finally {
      setDetectingTiming(false);
    }
  }

  async function deleteStreet(street: Street) {
    try { await streetsApi.delete(street.id); onRefresh(); }
    catch { toast.error('Delete failed'); }
  }

  async function addStreet() {
    if (!inter || !newStreetName.trim()) return;
    setAddingStreet(true);
    try {
      await streetsApi.create({ intersection_id: inter.id, name: newStreetName.trim(), arm_direction: newStreetDir as Street['arm_direction'] });
      setNewStreetName(''); setNewStreetDir('unknown');
      onRefresh();
    } catch { toast.error('Failed to add street'); }
    finally { setAddingStreet(false); }
  }

  async function addCamera() {
    if (!inter || !newCamRtsp.trim()) return;
    setAddingCam(true);
    try {
      await cctvsApi.create({ intersection_id: inter.id, name: newCamName || `Camera ${cameras.length + 1}`, rtsp_url: newCamRtsp.trim() });
      setNewCamName(''); setNewCamRtsp('');
      onRefresh();
    } catch { toast.error('Failed to add camera'); }
    finally { setAddingCam(false); }
  }

  async function deleteCamera(cam: CCTV) {
    try { await cctvsApi.delete(cam.id); onRefresh(); }
    catch { toast.error('Delete failed'); }
  }

  async function deleteIntersection() {
    if (!inter) return;
    try { await intersectionsApi.delete(inter.id); onRefresh(); onClose(); }
    catch { toast.error('Delete failed'); }
  }

  if (!inter) return null;

  const DIRECTION_OPTIONS = [
    { value: 'northbound', label: 'Northbound' },
    { value: 'southbound', label: 'Southbound' },
    { value: 'eastbound',  label: 'Eastbound'  },
    { value: 'westbound',  label: 'Westbound'  },
    { value: 'unknown',    label: 'Unknown'     },
  ];

  const bucket = rec ? statusBucket(rec) : null;
  const onlineCount = cameras.filter(c => c.status === 'online').length;

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto flex flex-col gap-0 px-0 pt-0 pb-0">
        {/* Fixed header */}
        <div className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <SheetHeader>
            <SheetTitle className="text-base">{inter.name}</SheetTitle>
          </SheetHeader>
          {/* Summary strip */}
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {bucket && (
              <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[bucket])}>
                {BUCKET_LABEL[bucket]}
              </Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">
              {inter.signal_status.replace('_', ' ')}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {onlineCount}/{cameras.length} cameras online
            </span>
            {inter.existing_cycle_length && (
              <span className="text-xs text-muted-foreground">
                · {inter.existing_cycle_length}s cycle
              </span>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">

          {/* Basic info */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Intersection</p>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Latitude</Label>
                <Input value={lat} onChange={e => setLat(e.target.value)} className="h-8 text-sm font-mono" />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Longitude</Label>
                <Input value={lng} onChange={e => setLng(e.target.value)} className="h-8 text-sm font-mono" />
              </div>
            </div>
          </div>

          <Separator />

          {/* Signal */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Signal timing</p>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Signal status</Label>
              <Select value={signalStatus} onValueChange={v => setSignalStatus(v as SignalStatus)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SIGNAL_STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {signalStatus !== 'unsignalized' && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Current cycle length (seconds)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number" min={0} placeholder="e.g. 90"
                    value={cycleLen} onChange={e => setCycleLen(e.target.value)}
                    className="h-8 text-sm flex-1"
                  />
                  <Button size="sm" variant="outline" className="h-8 px-2 shrink-0" onClick={detect} disabled={detectingTiming} title="Detect from camera feed">
                    {detectingTiming ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
                  </Button>
                </div>
                {detectResult && (
                  <p className="text-xs text-muted-foreground">{detectResult.confidence} confidence — {detectResult.note}</p>
                )}
              </div>
            )}
          </div>

          <Separator />

          {/* Cameras */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Cameras ({cameras.length})
            </p>
            {cameras.length === 0 ? (
              <p className="text-xs text-muted-foreground">No cameras added yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {cameras.map(cam => (
                  <div key={cam.id} className="rounded-lg border border-border bg-muted/10 overflow-hidden">
                    {/* Thumbnail */}
                    <div className="relative h-20 bg-black">
                      <img
                        src={cctvsApi.snapshotUrl(cam.id)}
                        alt={cam.name}
                        className="w-full h-full object-cover opacity-80"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                      <span className={cn('absolute top-1.5 left-1.5 size-2 rounded-full',
                        cam.status === 'online' ? 'bg-emerald-400' :
                        cam.status === 'reconnecting' ? 'bg-amber-400' : 'bg-red-400',
                      )} />
                    </div>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{cam.name}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">{cam.rtsp_url}</p>
                      </div>
                      <Link to={`/cameras/${cam.id}`} className="shrink-0" title="Draw detection regions">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] gap-1">
                          <ExternalLink className="size-3" />
                          Regions
                        </Button>
                      </Link>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button className="shrink-0 p-1 text-muted-foreground hover:text-destructive transition-colors" aria-label={`Delete ${cam.name}`}>
                            <Trash2 className="size-3.5" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {cam.name}?</AlertDialogTitle>
                            <AlertDialogDescription>This will remove the camera and stop detection.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteCamera(cam)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
              <p className="text-xs text-muted-foreground">Add camera</p>
              <Input placeholder="Camera name (optional)" value={newCamName} onChange={e => setNewCamName(e.target.value)} className="h-8 text-sm" />
              <Input placeholder="rtsp://..." value={newCamRtsp} onChange={e => setNewCamRtsp(e.target.value)} className="h-8 text-sm font-mono" />
              <Button size="sm" variant="outline" className="w-fit" onClick={addCamera} disabled={addingCam || !newCamRtsp.trim()}>
                {addingCam ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Plus className="size-3.5 mr-1.5" />}
                Add camera
              </Button>
            </div>
          </div>

          <Separator />

          {/* Approach directions — staged, saved with the main Save button */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Approach directions</p>
              {hasUnsavedDirs && (
                <span className="text-[10px] text-amber-600 font-medium">unsaved changes</span>
              )}
            </div>
            {streets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No approaches configured yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {streets.map(s => {
                  const effectiveDir = stagingDirs[s.id] ?? s.arm_direction;
                  const isDirty = stagingDirs[s.id] !== undefined && stagingDirs[s.id] !== s.arm_direction;
                  return (
                    <div key={s.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-2',
                      isDirty ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20' : 'border-border',
                    )}>
                      <span className="text-sm flex-1 truncate">{s.name}</span>
                      <Select value={effectiveDir} onValueChange={v => setStagingDirs(prev => ({ ...prev, [s.id]: v }))}>
                        <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DIRECTION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button className="text-muted-foreground hover:text-destructive transition-colors" aria-label={`Delete ${s.name}`}>
                            <Trash2 className="size-3.5" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader><AlertDialogTitle>Delete "{s.name}"?</AlertDialogTitle></AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteStreet(s)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3">
              <Input placeholder="Street name" value={newStreetName} onChange={e => setNewStreetName(e.target.value)} className="h-7 text-xs flex-1" />
              <Select value={newStreetDir} onValueChange={setNewStreetDir}>
                <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DIRECTION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={addStreet} disabled={addingStreet || !newStreetName.trim()}>
                {addingStreet ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </Button>
            </div>
          </div>

          <Separator />

          {/* Single save button */}
          <Button onClick={saveAll} disabled={saving} className="w-full">
            {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
            Save all changes
          </Button>

          <Separator />

          {/* Danger zone */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Danger zone</p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" className="w-fit">
                  <Trash2 className="size-3.5 mr-1.5" />
                  Delete intersection
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {inter.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Permanently deletes all cameras, streets, regions, and detection data for this intersection.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteIntersection} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Delete everything
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Hero stats ────────────────────────────────────────────────────────────────

const PEDESTRIAN_TYPES = new Set(['pedestrian', 'person']);

const TYPE_HEX: Record<string, string> = {
  car:        '#16a34a',
  motorcycle: '#0369a1',
  tricycle:   '#d97706',
  truck:      '#dc2626',
  pedicab:    '#7c3aed',
  pedestrian: '#0891b2',
  person:     '#0891b2',
};

// ── Page ─────────────────────────────────────────────────────────────────────

export function IntersectionsPage() {
  const { sseData, onOpenWizard } = useOutletContext<{ sseData: AggregationRow[] | null; sseStatus: SSEStatus; onOpenWizard: () => void }>();

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

  const heroStats = useMemo(() => {
    let vehicles = 0, pedestrians = 0;
    const byType: Record<string, number> = {};
    for (const r of sseData ?? []) {
      if (PEDESTRIAN_TYPES.has(r.object_type)) pedestrians += r.count;
      else { vehicles += r.count; byType[r.object_type] = (byType[r.object_type] ?? 0) + r.count; }
    }
    const topTypes = Object.entries(byType).sort(([, a], [, b]) => b - a).slice(0, 3);
    const camOnline       = cameras.filter(c => c.status === 'online').length;
    const camReconnecting = cameras.filter(c => c.status === 'reconnecting').length;
    const camOffline      = cameras.filter(c => c.status === 'offline').length;
    const activeIntersections = Object.keys(liveCountByIntersection).length;
    return { vehicles, pedestrians, topTypes, camOnline, camReconnecting, camOffline, activeIntersections };
  }, [sseData, cameras, liveCountByIntersection]);

  const [viewMode, setViewMode]               = useState<'grid' | 'map'>('grid');
  const [generatingAll, setGeneratingAll]     = useState(false);
  const [wizardOpen, setWizardOpen]           = useState(false);
  const [settingsTarget, setSettingsTarget]   = useState<Intersection | null>(null);

  async function runAllAnalyses() {
    setGeneratingAll(true);
    try {
      const results = await recommendationsApi.generateAll();
      setRecs(new Map(results.map(r => [r.intersection_id, r])));
      const warranted = results.filter(r => r.recommended).length;
      toast.success(`Analysis complete — ${warranted} warranted`);
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
          <Button onClick={() => setWizardOpen(true)}>
            <Plus className="size-4 mr-2" />
            Set up intersection
          </Button>
        </div>
      </div>

      {/* Hero stats — visible once data loads */}
      {!loading && intersections.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Vehicles</p>
                  <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                    {sseData ? heroStats.vehicles.toLocaleString() : '—'}
                  </p>
                </div>
                <div className="rounded-lg bg-green-100 p-2">
                  <TrendingUp className="size-4 text-green-700" />
                </div>
              </div>
              {heroStats.topTypes.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1">
                  {heroStats.topTypes.map(([type, count]) => (
                    <span key={type} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: TYPE_HEX[type] ?? '#16a34a' }} />
                      {type[0].toUpperCase() + type.slice(1)} <strong className="font-semibold text-foreground">{count}</strong>
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Pedestrians</p>
                  <p className="mt-1 text-3xl font-black tabular-nums leading-none">
                    {sseData ? heroStats.pedestrians.toLocaleString() : '—'}
                  </p>
                </div>
                <div className="rounded-lg bg-cyan-100 p-2">
                  <Users className="size-4 text-cyan-700" />
                </div>
              </div>
              <p className="mt-3 text-[10px] text-muted-foreground">
                {sseData && (heroStats.vehicles + heroStats.pedestrians) > 0
                  ? `${Math.round((heroStats.pedestrians / (heroStats.vehicles + heroStats.pedestrians)) * 100)}% of total`
                  : 'awaiting live data'}
              </p>
            </CardContent>
          </Card>

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
            <Button onClick={onOpenWizard}>
              <Rocket className="size-4 mr-2" />
              Get Started
            </Button>
            <Button variant="outline" onClick={() => setWizardOpen(true)}>
              <Plus className="size-4 mr-2" />
              Quick add
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

      <IntersectionSetupWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => { setWizardOpen(false); load(); }}
      />

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
