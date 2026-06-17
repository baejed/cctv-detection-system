import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { cctvsApi } from '@/services/cctvs';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import type { ArmDirection } from '@/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ScanSearch, Plus, CheckCircle2, ArrowRight, ArrowLeft, Wifi, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const TAGUM_CENTER: [number, number] = [7.4478, 125.8057];

function MapClickPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: e => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

const DIRECTIONS: { value: ArmDirection; label: string }[] = [
  { value: 'northbound', label: 'Northbound (N)' },
  { value: 'southbound', label: 'Southbound (S)' },
  { value: 'eastbound',  label: 'Eastbound (E)'  },
  { value: 'westbound',  label: 'Westbound (W)'  },
  { value: 'unknown',    label: 'Unknown'         },
];

type WizardStep = 'discover' | 'name' | 'assign' | 'done';

interface FoundCamera {
  key: string;
  address: string;
  rtsp_url: string;
  selected: boolean;
}

interface WizardCamera {
  key: string;
  rtsp_url: string;
  name: string;
  direction: ArmDirection;
}

export interface IntersectionSetupWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (intersectionId: number) => void;
}

export function IntersectionSetupWizard({ open, onClose, onCreated }: IntersectionSetupWizardProps) {
  const navigate = useNavigate();

  const [step, setStep]               = useState<WizardStep>('discover');
  const [scanning, setScanning]       = useState(false);
  const [nvrScanning, setNvrScanning] = useState(false);
  const [found, setFound]             = useState<FoundCamera[]>([]);
  const [nvrHost, setNvrHost]         = useState('');
  const [nvrUser, setNvrUser]         = useState('admin');
  const [nvrPass, setNvrPass]         = useState('');
  const [showNvr, setShowNvr]         = useState(false);
  const [manualUrl, setManualUrl]     = useState('');

  const [interName, setInterName] = useState('');
  const [lat, setLat]             = useState('');
  const [lng, setLng]             = useState('');

  const [cameras, setCameras]   = useState<WizardCamera[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [createdCameras, setCreatedCameras] = useState<{ id: number; name: string }[]>([]);

  function reset() {
    setStep('discover');
    setScanning(false);
    setFound([]);
    setNvrHost('');
    setNvrUser('admin');
    setNvrPass('');
    setShowNvr(false);
    setManualUrl('');
    setInterName('');
    setLat('');
    setLng('');
    setCameras([]);
    setCreating(false);
    setCreatedId(null);
    setCreatedCameras([]);
  }

  function handleClose() {
    reset();
    onClose();
  }

  // ── Step 1: discover ────────────────────────────────────────────────────────

  async function scanNetwork() {
    setScanning(true);
    try {
      const results = await cctvsApi.discover();
      if (results.length === 0) {
        toast.info('No ONVIF cameras found on the network. Try NVR scan or add manually.');
      }
      setFound(prev => {
        const existing = new Set(prev.map(f => f.address));
        const fresh = results
          .filter(r => !existing.has(r.address))
          .map((r, i) => ({
            key:      `onvif-${r.address}-${i}`,
            address:  r.address,
            rtsp_url: r.rtsp_url ?? `rtsp://${r.address}:554/stream1`,
            selected: true,
          }));
        return [...prev, ...fresh];
      });
    } catch {
      toast.error('Network scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function scanNvr() {
    if (!nvrHost) return;
    setNvrScanning(true);
    try {
      const result = await cctvsApi.scanNvr({
        host: nvrHost, username: nvrUser, password: nvrPass,
        max_channels: 16, subtype: 1,
      });
      if (!result.reachable) {
        toast.error(`NVR at ${nvrHost} is not reachable`);
        return;
      }
      setFound(prev => {
        const existing = new Set(prev.map(f => f.rtsp_url));
        const fresh = result.channels
          .filter(ch => !existing.has(ch.rtsp_url))
          .map(ch => ({
            key:      `nvr-${nvrHost}-ch${ch.channel}`,
            address:  `${nvrHost} Ch${ch.channel}`,
            rtsp_url: ch.rtsp_url,
            selected: true,
          }));
        return [...prev, ...fresh];
      });
      toast.success(`Found ${result.channels.length} channels on NVR`);
    } catch {
      toast.error('NVR scan failed');
    } finally {
      setNvrScanning(false);
    }
  }

  function addManual() {
    if (!manualUrl.trim()) return;
    setFound(prev => [...prev, {
      key:      `manual-${Date.now()}`,
      address:  'Manual entry',
      rtsp_url: manualUrl.trim(),
      selected: true,
    }]);
    setManualUrl('');
  }

  function toggleCamera(key: string) {
    setFound(prev => prev.map(f => f.key === key ? { ...f, selected: !f.selected } : f));
  }

  function updateRtsp(key: string, url: string) {
    setFound(prev => prev.map(f => f.key === key ? { ...f, rtsp_url: url } : f));
  }

  function goToName() {
    const selected = found.filter(f => f.selected);
    if (selected.length === 0) { toast.error('Select at least one camera'); return; }
    setStep('name');
  }

  // ── Step 2: name ────────────────────────────────────────────────────────────

  function goToAssign() {
    if (!interName.trim()) { toast.error('Enter an intersection name'); return; }
    const selected = found.filter(f => f.selected);
    setCameras(selected.map((f, i) => ({
      key:       f.key,
      rtsp_url:  f.rtsp_url,
      name:      `Camera ${i + 1}`,
      direction: (['northbound', 'southbound', 'eastbound', 'westbound', 'unknown'] as ArmDirection[])[i] ?? 'unknown',
    })));
    setStep('assign');
  }

  function updateCameraField(key: string, field: 'name' | 'direction', value: string) {
    setCameras(prev => prev.map(c => c.key === key ? { ...c, [field]: value } : c));
  }

  // ── Step 3: create ──────────────────────────────────────────────────────────

  async function createIntersection() {
    setCreating(true);
    try {
      const inter = await intersectionsApi.create({
        name:      interName.trim(),
        latitude:  parseFloat(lat) || TAGUM_CENTER[0],
        longitude: parseFloat(lng) || TAGUM_CENTER[1],
      });

      // Streets + cameras in parallel
      const uniqueDirs = [...new Set(cameras.map(c => c.direction))];
      const [, camResults] = await Promise.all([
        Promise.all(uniqueDirs.map(dir =>
          streetsApi.create({ intersection_id: inter.id, name: dir.charAt(0).toUpperCase() + dir.slice(1), arm_direction: dir as ArmDirection })
        )),
        Promise.all(cameras.map(c =>
          cctvsApi.create({ intersection_id: inter.id, name: c.name, rtsp_url: c.rtsp_url })
        )),
      ]);
      setCreatedCameras(camResults.map(c => ({ id: c.id, name: c.name })));
      setCreatedId(inter.id);
      setStep('done');
      onCreated(inter.id);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create intersection');
    } finally {
      setCreating(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const selectedCount = found.filter(f => f.selected).length;

  const STEP_LABELS: Record<WizardStep, string> = {
    discover: '1. Find cameras',
    name:     '2. Name intersection',
    assign:   '3. Assign directions',
    done:     'Done',
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{STEP_LABELS[step]}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1">

          {/* ── Step 1: discover ── */}
          {step === 'discover' && (
            <div className="flex flex-col gap-5 py-2">

              {/* ONVIF scan */}
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Scan the local network for ONVIF cameras (takes ~3 seconds).
                </p>
                <Button
                  onClick={scanNetwork}
                  disabled={scanning}
                  className="w-full sm:w-auto"
                  size="lg"
                >
                  {scanning
                    ? <Loader2 className="size-4 mr-2 animate-spin" />
                    : <ScanSearch className="size-4 mr-2" />}
                  {scanning ? 'Scanning network…' : 'Scan Network'}
                </Button>
              </div>

              {/* NVR scan toggle */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
                  onClick={() => setShowNvr(v => !v)}
                >
                  <Server className="size-3.5" />
                  {showNvr ? 'Hide' : 'Scan NVR / DVR instead'}
                </button>
                {showNvr && (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col gap-3">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-3 sm:col-span-1 flex flex-col gap-1">
                        <Label className="text-xs">NVR IP</Label>
                        <Input placeholder="192.168.1.100" value={nvrHost} onChange={e => setNvrHost(e.target.value)} className="h-8 text-sm" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Username</Label>
                        <Input placeholder="admin" value={nvrUser} onChange={e => setNvrUser(e.target.value)} className="h-8 text-sm" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Password</Label>
                        <Input type="password" value={nvrPass} onChange={e => setNvrPass(e.target.value)} className="h-8 text-sm" />
                      </div>
                    </div>
                    <Button size="sm" onClick={scanNvr} disabled={nvrScanning || !nvrHost} className="w-fit">
                      {nvrScanning ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Server className="size-3.5 mr-1.5" />}
                      Scan NVR
                    </Button>
                  </div>
                )}
              </div>

              {/* Found cameras list */}
              {found.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {found.length} camera{found.length !== 1 ? 's' : ''} found - select which to add
                  </p>
                  <div className="flex flex-col gap-2">
                    {found.map(cam => (
                      <label
                        key={cam.key}
                        className={cn(
                          'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                          cam.selected ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/20',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={cam.selected}
                          onChange={() => toggleCamera(cam.key)}
                          className="mt-0.5 accent-primary"
                        />
                        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                          <div className="flex items-center gap-2">
                            <Wifi className="size-3.5 text-emerald-500 shrink-0" />
                            <span className="text-sm font-medium truncate">{cam.address}</span>
                          </div>
                          <Input
                            value={cam.rtsp_url}
                            onChange={e => updateRtsp(cam.key, e.target.value)}
                            onClick={e => e.stopPropagation()}
                            placeholder="rtsp://..."
                            className="h-7 text-xs font-mono"
                          />
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual entry */}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">Or add a camera by RTSP URL directly:</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="rtsp://192.168.1.200:554/stream1"
                    value={manualUrl}
                    onChange={e => setManualUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addManual()}
                    className="font-mono text-sm"
                  />
                  <Button variant="outline" onClick={addManual} disabled={!manualUrl.trim()}>
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button onClick={goToName} disabled={selectedCount === 0}>
                  Next - name this intersection
                  <ArrowRight className="size-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: name ── */}
          {step === 'name' && (
            <div className="flex flex-col gap-5 py-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inter-name" className="text-sm font-medium">Intersection name</Label>
                <Input
                  id="inter-name"
                  autoFocus
                  autoComplete="off"
                  placeholder="e.g. Magugpo Junction, City Hall…"
                  value={interName}
                  onChange={e => setInterName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && goToAssign()}
                  className="text-base h-11"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">Pin the location on the map (optional - click to place):</p>
                <div className="rounded-lg overflow-hidden border border-border" style={{ height: 240, isolation: 'isolate' }}>
                  <MapContainer
                    center={lat && lng ? [parseFloat(lat), parseFloat(lng)] : TAGUM_CENTER}
                    zoom={14}
                    style={{ height: '100%' }}
                  >
                    <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    <MapClickPicker onPick={(la, lo) => { setLat(la.toFixed(6)); setLng(lo.toFixed(6)); }} />
                    {lat && lng && <Marker position={[parseFloat(lat), parseFloat(lng)]} />}
                  </MapContainer>
                </div>
                {lat && lng && (
                  <p className="text-xs text-muted-foreground font-mono">{lat}, {lng}</p>
                )}
              </div>

              <div className="flex justify-between pt-2">
                <Button variant="outline" onClick={() => setStep('discover')}>
                  <ArrowLeft className="size-4 mr-2" /> Back
                </Button>
                <Button onClick={goToAssign} disabled={!interName.trim()}>
                  Next - assign directions
                  <ArrowRight className="size-4 ml-2" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: assign ── */}
          {step === 'assign' && (
            <div className="flex flex-col gap-5 py-2">
              <p className="text-sm text-muted-foreground">
                Give each camera a name and assign it to an approach direction.
                This tells the system which side of the intersection each camera covers.
              </p>

              <div className="flex flex-col gap-3">
                {cameras.map((cam, i) => (
                  <div key={cam.key} className="rounded-lg border border-border bg-muted/20 p-4 flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground font-mono truncate">{cam.rtsp_url}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Camera name</Label>
                        <Input
                          value={cam.name}
                          onChange={e => updateCameraField(cam.key, 'name', e.target.value)}
                          placeholder={`Camera ${i + 1}`}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Approach direction</Label>
                        <Select
                          value={cam.direction}
                          onValueChange={v => updateCameraField(cam.key, 'direction', v)}
                        >
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DIRECTIONS.map(d => (
                              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-between pt-2">
                <Button variant="outline" onClick={() => setStep('name')}>
                  <ArrowLeft className="size-4 mr-2" /> Back
                </Button>
                <Button onClick={createIntersection} disabled={creating}>
                  {creating
                    ? <Loader2 className="size-4 mr-2 animate-spin" />
                    : <CheckCircle2 className="size-4 mr-2" />}
                  {creating ? 'Creating…' : 'Create intersection'}
                </Button>
              </div>
            </div>
          )}

          {/* ── Done ── */}
          {step === 'done' && createdId != null && (
            <div className="flex flex-col gap-6 py-4">
              <div className="flex flex-col items-center gap-3 text-center">
                <CheckCircle2 className="size-14 text-emerald-500" />
                <div>
                  <h3 className="text-lg font-semibold">{interName} is set up</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Cameras are connecting. Vehicle detection will start automatically.
                  </p>
                </div>
              </div>

              {/* Region drawing - critical next step */}
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-4 flex flex-col gap-3">
                <div>
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                    Next step: draw detection regions
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                    A region is a polygon you draw on the camera snapshot to mark the counting zone for each approach arm.
                    Without regions, no vehicles will be counted and warrant analysis won't have data.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  {createdCameras.map(cam => (
                    <button
                      key={cam.id}
                      onClick={() => { handleClose(); navigate(`/intersections/${createdId}/cameras/${cam.id}`); }}
                      className="flex items-center justify-between rounded-md bg-white dark:bg-background border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm font-medium hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-amber-400 shrink-0" />
                        {cam.name}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                        Draw regions <ArrowRight className="size-3" />
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 justify-center">
                <Button onClick={() => { handleClose(); navigate(`/intersections/${createdId}/timing`); }} variant="outline">
                  View signal timing
                </Button>
                <Button variant="outline" onClick={reset}>
                  Set up another
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
