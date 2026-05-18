import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { intersectionsApi } from '@/services/intersections';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import type { Intersection, SignalStatus, Street } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { MapPin, Plus, Pencil, Trash2, ChevronRight, Loader2, TrafficCone } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';

// Fix leaflet marker icons in Vite
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

interface InterForm { name: string; latitude: string; longitude: string }
const EMPTY_INTER: InterForm = { name: '', latitude: '', longitude: '' };

interface TimingForm {
  signal_status: SignalStatus;
  existing_cycle_length: string;
  existing_green_splits: string;
}
const EMPTY_TIMING: TimingForm = {
  signal_status: 'unsignalized',
  existing_cycle_length: '',
  existing_green_splits: '',
};

const SIGNAL_STATUS_LABEL: Record<SignalStatus, string> = {
  unsignalized: 'Unsignalized',
  fixed_time:   'Fixed-time',
  actuated:     'Actuated',
};

export function IntersectionsPage() {
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [streets, setStreets] = useState<Street[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [showInterModal, setShowInterModal] = useState(false);
  const [editingInter, setEditingInter] = useState<Intersection | null>(null);
  const [interForm, setInterForm] = useState<InterForm>(EMPTY_INTER);
  const [savingInter, setSavingInter] = useState(false);

  const [showStreetModal, setShowStreetModal] = useState(false);
  const [streetParent, setStreetParent] = useState<Intersection | null>(null);
  const [editingStreet, setEditingStreet] = useState<Street | null>(null);
  const [streetName, setStreetName] = useState('');
  const [savingStreet, setSavingStreet] = useState(false);

  const [showTimingModal, setShowTimingModal] = useState(false);
  const [timingTarget, setTimingTarget] = useState<Intersection | null>(null);
  const [timingForm, setTimingForm] = useState<TimingForm>(EMPTY_TIMING);
  const [savingTiming, setSavingTiming] = useState(false);

  const [recsById, setRecsById] = useState<Map<number, RecommendationResponse>>(new Map());

  async function load() {
    try {
      const [ints, strs] = await Promise.all([intersectionsApi.list(), streetsApi.list()]);
      setIntersections(ints);
      setStreets(strs);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    let cancelled = false;
    recommendationsApi.list()
      .then(recs => {
        if (cancelled) return;
        setRecsById(new Map(recs.map(r => [r.intersection_id, r])));
      })
      .catch(() => { /* silent — page works without recs */ });
    return () => { cancelled = true; };
  }, []);

  function toggle(id: number) {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function saveInter() {
    if (!interForm.name) return;
    setSavingInter(true);
    try {
      const data = { name: interForm.name, latitude: parseFloat(interForm.latitude) || 0, longitude: parseFloat(interForm.longitude) || 0 };
      if (editingInter) { await intersectionsApi.update(editingInter.id, data); toast.success('Updated'); }
      else { await intersectionsApi.create(data); toast.success('Intersection added'); }
      setShowInterModal(false); load();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSavingInter(false); }
  }

  async function deleteInter(i: Intersection) {
    try { await intersectionsApi.delete(i.id); toast.success('Deleted'); load(); }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Delete failed'); }
  }

  async function saveStreet() {
    if (!streetName || !streetParent) return;
    setSavingStreet(true);
    try {
      if (editingStreet) { await streetsApi.update(editingStreet.id, { name: streetName }); toast.success('Updated'); }
      else { await streetsApi.create({ intersection_id: streetParent.id, name: streetName }); toast.success('Street added'); }
      setShowStreetModal(false); load();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSavingStreet(false); }
  }

  async function deleteStreet(s: Street) {
    try { await streetsApi.delete(s.id); toast.success('Deleted'); load(); }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Delete failed'); }
  }

  function openTimingModal(inter: Intersection) {
    setTimingTarget(inter);
    setTimingForm({
      signal_status: inter.signal_status ?? 'unsignalized',
      existing_cycle_length: inter.existing_cycle_length != null ? String(inter.existing_cycle_length) : '',
      existing_green_splits: inter.existing_green_splits ? JSON.stringify(inter.existing_green_splits, null, 2) : '',
    });
    setShowTimingModal(true);
  }

  async function saveTiming() {
    if (!timingTarget) return;
    setSavingTiming(true);
    try {
      let splits: Record<string, number> | null = null;
      if (timingForm.existing_green_splits.trim()) {
        splits = JSON.parse(timingForm.existing_green_splits);
      }
      await intersectionsApi.patchTiming(timingTarget.id, {
        signal_status: timingForm.signal_status,
        existing_cycle_length: timingForm.existing_cycle_length ? parseInt(timingForm.existing_cycle_length) : null,
        existing_green_splits: splits,
      });
      toast.success('Signal timing saved');
      setShowTimingModal(false);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingTiming(false);
    }
  }

  const mapMarkers = intersections.filter(i => i.latitude && i.longitude);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Intersections</h1>
        <Button size="sm" onClick={() => { setEditingInter(null); setInterForm(EMPTY_INTER); setShowInterModal(true); }}>
          <Plus data-icon="inline-start" />
          Add Intersection
        </Button>
      </div>

      {/* Map */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3">
          <div className="flex items-center gap-2">
            <MapPin className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Map</CardTitle>
            <Badge variant="secondary" className="ml-auto">{mapMarkers.length} pinned</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <MapContainer center={TAGUM_CENTER} zoom={13} style={{ height: 300 }}>
            <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {mapMarkers.map(i => (
              <Marker key={i.id} position={[i.latitude, i.longitude]}>
                <Popup>{i.name}</Popup>
              </Marker>
            ))}
          </MapContainer>
        </CardContent>
      </Card>

      {/* Intersection list */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : intersections.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <MapPin className="size-10 opacity-30" />
              <p className="text-sm">No intersections yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Coordinates</TableHead>
                  <TableHead>Streets</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {intersections.flatMap(inter => {
                  const interStreets = streets.filter(s => s.intersection_id === inter.id);
                  const isOpen = expanded.has(inter.id);
                  return [
                    <TableRow key={inter.id}>
                      <TableCell>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          className="flex items-center gap-1.5 font-medium hover:text-primary transition-colors"
                          onClick={() => toggle(inter.id)}
                        >
                          <ChevronRight className={`size-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                          {inter.name}
                        </button>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {inter.latitude?.toFixed(4)}, {inter.longitude?.toFixed(4)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary">{interStreets.length}</Badge>
                          {(() => {
                            const rec = recsById.get(inter.id);
                            if (!rec) return null;
                            const b = statusBucket(rec);
                            return (
                              <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[b])}>
                                {BUCKET_LABEL[b]}
                              </Badge>
                            );
                          })()}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 justify-end">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                            onClick={() => openTimingModal(inter)}
                            aria-label={`Signal timing for ${inter.name}`}>
                            <TrafficCone className="size-3 mr-1" aria-hidden="true" />
                            Timing
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                            onClick={() => { setStreetParent(inter); setEditingStreet(null); setStreetName(''); setShowStreetModal(true); }}>
                            + Street
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit ${inter.name}`}
                            onClick={() => { setEditingInter(inter); setInterForm({ name: inter.name, latitude: String(inter.latitude ?? ''), longitude: String(inter.longitude ?? '') }); setShowInterModal(true); }}>
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" aria-label={`Delete ${inter.name}`}>
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {inter.name}?</AlertDialogTitle>
                                <AlertDialogDescription>Deletes all streets, cameras, regions, and detections for this intersection.</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteInter(inter)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>,
                    isOpen && (
                      <TableRow key={`${inter.id}-streets`} className="bg-muted/20">
                        <TableCell colSpan={4} className="pl-8 py-3">
                          {interStreets.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No streets -add approach directions above.</p>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {interStreets.map(s => (
                                <div key={s.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-1.5 text-sm">
                                  <span>{s.name}</span>
                                  <div className="flex gap-1">
                                    <Button variant="ghost" size="icon" className="size-6" aria-label={`Edit street ${s.name}`}
                                      onClick={() => { setStreetParent(inter); setEditingStreet(s); setStreetName(s.name); setShowStreetModal(true); }}>
                                      <Pencil className="size-3" aria-hidden="true" />
                                    </Button>
                                    <AlertDialog>
                                      <AlertDialogTrigger asChild>
                                        <Button variant="ghost" size="icon" className="size-6 text-destructive hover:text-destructive" aria-label={`Delete street ${s.name}`}>
                                          <Trash2 className="size-3" aria-hidden="true" />
                                        </Button>
                                      </AlertDialogTrigger>
                                      <AlertDialogContent>
                                        <AlertDialogHeader>
                                          <AlertDialogTitle>Delete street "{s.name}"?</AlertDialogTitle>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                                          <AlertDialogAction onClick={() => deleteStreet(s)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                                        </AlertDialogFooter>
                                      </AlertDialogContent>
                                    </AlertDialog>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ),
                  ].filter(Boolean);
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Intersection modal */}
      <Dialog open={showInterModal} onOpenChange={setShowInterModal}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingInter ? 'Edit Intersection' : 'Add Intersection'}</DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex flex-col gap-4 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inter-name">Name</Label>
              <Input
                id="inter-name"
                name="intersection-name"
                autoComplete="off"
                autoFocus
                value={interForm.name}
                onChange={e => setInterForm({ ...interForm, name: e.target.value })}
                placeholder="e.g. City Hall Intersection…"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inter-lat">Latitude</Label>
                <Input
                  id="inter-lat"
                  name="latitude"
                  type="number"
                  step="any"
                  value={interForm.latitude}
                  onChange={e => setInterForm({ ...interForm, latitude: e.target.value })}
                  placeholder="7.4478"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inter-lng">Longitude</Label>
                <Input
                  id="inter-lng"
                  name="longitude"
                  type="number"
                  step="any"
                  value={interForm.longitude}
                  onChange={e => setInterForm({ ...interForm, longitude: e.target.value })}
                  placeholder="125.8057"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                Or click the map to pin the location:
              </p>
              {/* isolation: isolate contains Leaflet's z-index stack inside the dialog */}
              <div className="rounded-lg overflow-hidden border border-border" style={{ height: 260, isolation: 'isolate' }}>
                <MapContainer
                  center={interForm.latitude && interForm.longitude
                    ? [parseFloat(interForm.latitude), parseFloat(interForm.longitude)]
                    : TAGUM_CENTER}
                  zoom={14}
                  style={{ height: '100%' }}
                >
                  <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <MapClickPicker onPick={(lat, lng) => setInterForm({ ...interForm, latitude: lat.toFixed(6), longitude: lng.toFixed(6) })} />
                  {interForm.latitude && interForm.longitude && (
                    <Marker position={[parseFloat(interForm.latitude), parseFloat(interForm.longitude)]} />
                  )}
                </MapContainer>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInterModal(false)}>Cancel</Button>
            <Button onClick={saveInter} disabled={savingInter || !interForm.name}>
              {savingInter && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {editingInter ? 'Save Changes' : 'Add Intersection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Signal timing modal */}
      <Dialog open={showTimingModal} onOpenChange={setShowTimingModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Signal Timing — {timingTarget?.name}</DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex flex-col gap-4 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signal-status">Signal Status</Label>
              <Select
                value={timingForm.signal_status}
                onValueChange={v => setTimingForm({ ...timingForm, signal_status: v as SignalStatus })}
              >
                <SelectTrigger id="signal-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SIGNAL_STATUS_LABEL) as SignalStatus[]).map(s => (
                    <SelectItem key={s} value={s}>{SIGNAL_STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cycle-length">Existing Cycle Length (seconds)</Label>
              <Input
                id="cycle-length"
                type="number"
                min={0}
                placeholder="e.g. 90"
                value={timingForm.existing_cycle_length}
                onChange={e => setTimingForm({ ...timingForm, existing_cycle_length: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Leave blank if unknown — equal-split default will be used.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="green-splits">Existing Green Splits (JSON)</Label>
              <textarea
                id="green-splits"
                className="min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={'{"northbound": 20, "southbound": 20, "eastbound": 20, "westbound": 20}'}
                value={timingForm.existing_green_splits}
                onChange={e => setTimingForm({ ...timingForm, existing_green_splits: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Keyed by approach/street name, values in seconds. Leave blank to use equal-split.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTimingModal(false)}>Cancel</Button>
            <Button onClick={saveTiming} disabled={savingTiming}>
              {savingTiming && <Loader2 data-icon="inline-start" className="animate-spin" />}
              Save Timing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Street modal */}
      <Dialog open={showStreetModal} onOpenChange={setShowStreetModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editingStreet ? `Edit Street` : `Add Street`}
            </DialogTitle>
            {streetParent && (
              <p className="text-xs text-muted-foreground">
                {editingStreet ? `Renaming approach on ` : `New approach direction for `}
                <span className="font-medium text-foreground">{streetParent.name}</span>
              </p>
            )}
          </DialogHeader>
          <Separator />
          <div className="py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="street-name">Approach / Street Name</Label>
              <Input
                id="street-name"
                name="street-name"
                autoComplete="off"
                value={streetName}
                onChange={e => setStreetName(e.target.value)}
                placeholder="e.g. Northbound, Rizal Ave…"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && saveStreet()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStreetModal(false)}>Cancel</Button>
            <Button onClick={saveStreet} disabled={savingStreet || !streetName}>
              {savingStreet && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {editingStreet ? 'Save Changes' : 'Add Street'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
