import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { cctvsApi } from '@/services/cctvs';
import { intersectionsApi } from '@/services/intersections';
import type { ImportResult } from '@/services/intersections';
import { request } from '@/services/api';
import type { CCTV, Intersection } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Camera, Plus, Pencil, Trash2, Wifi, WifiOff, RefreshCw,
  Loader2, ScanSearch, ExternalLink, Download, Upload, FileText,
  CheckCircle2, XCircle, Server,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const CSV_TEMPLATE = `intersection_name,latitude,longitude,camera_name,rtsp_url
City Hall Intersection,7.4478,125.8057,Cam 1 North,rtsp://192.168.1.100:554/stream1
City Hall Intersection,7.4478,125.8057,Cam 1 South,rtsp://192.168.1.101:554/stream1
Magsaysay Park,7.4466,125.8048,Cam 2 East,rtsp://192.168.1.102:554/stream1
`;

function downloadTemplate() {
  const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cameras_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function StatusBadge({ status, lastError }: { status: string; lastError?: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Badge variant="outline" className={cn(
        'text-xs w-fit',
        status === 'online'       && 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10',
        status === 'reconnecting' && 'border-amber-500/40 text-amber-400 bg-amber-500/10',
        status === 'offline'      && 'border-destructive/40 text-destructive bg-destructive/10',
      )}>
        {status === 'online'       && <Wifi className="size-2.5 mr-1" aria-hidden="true" />}
        {status === 'reconnecting' && <RefreshCw className="size-2.5 mr-1 animate-spin" aria-hidden="true" />}
        {status === 'offline'      && <WifiOff className="size-2.5 mr-1" aria-hidden="true" />}
        {status}
      </Badge>
      {lastError && status !== 'online' && (
        <span className="text-[10px] text-muted-foreground max-w-[220px] truncate" title={lastError}>
          {lastError}
        </span>
      )}
    </div>
  );
}

interface FormData { name: string; rtsp_url: string; intersection_id: string }
const EMPTY: FormData = { name: '', rtsp_url: '', intersection_id: '' };

interface DiscoveredCamera {
  address: string;
  rtsp_url: string | null;
  xaddrs: string[];
}

interface NvrChannel {
  channel: number;
  rtsp_url: string;
}

interface NvrScanResult {
  reachable: boolean;
  channels: NvrChannel[];
}

const NVR_FORM_DEFAULT = { host: '', username: 'admin', password: '', maxChannels: 16, subtype: 1 };

export function CamerasPage() {
  const [cctvs, setCctvs] = useState<CCTV[]>([]);
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<CCTV | null>(null);
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);

  // ONVIF discovery
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredCamera[]>([]);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [importIntersectionId, setImportIntersectionId] = useState('');

  // NVR scan
  const [showNvrModal, setShowNvrModal] = useState(false);
  const [nvrForm, setNvrForm] = useState(NVR_FORM_DEFAULT);
  const [nvrIntersectionId, setNvrIntersectionId] = useState('');
  const [nvrScanning, setNvrScanning] = useState(false);
  const [nvrResult, setNvrResult] = useState<NvrScanResult | null>(null);
  const [nvrSelected, setNvrSelected] = useState<Set<number>>(new Set());
  const [nvrImporting, setNvrImporting] = useState(false);

  // CSV import
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvResult, setCsvResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [c, i] = await Promise.all([cctvsApi.list(), intersectionsApi.list()]);
      setCctvs(c);
      setIntersections(i);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); }
  function openEdit(c: CCTV) {
    setEditing(c);
    setForm({ name: c.name, rtsp_url: c.rtsp_url, intersection_id: String(c.intersection_id) });
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name || !form.rtsp_url || !form.intersection_id) return;
    setSaving(true);
    try {
      if (editing) {
        await cctvsApi.update(editing.id, { name: form.name, rtsp_url: form.rtsp_url, intersection_id: Number(form.intersection_id) });
        toast.success('Camera updated');
      } else {
        await cctvsApi.create({ name: form.name, rtsp_url: form.rtsp_url, intersection_id: Number(form.intersection_id) });
        toast.success('Camera added');
      }
      setShowModal(false);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c: CCTV) {
    try {
      await cctvsApi.delete(c.id);
      toast.success(`Deleted ${c.name}`);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleNvrScan() {
    if (!nvrForm.host) return;
    setNvrScanning(true);
    setNvrResult(null);
    setNvrSelected(new Set());
    try {
      const result = await cctvsApi.scanNvr({
        host: nvrForm.host,
        username: nvrForm.username,
        password: nvrForm.password,
        max_channels: nvrForm.maxChannels,
        subtype: nvrForm.subtype,
      });
      setNvrResult(result);
      if (!result.reachable) {
        toast.error(`Cannot reach RTSP on ${nvrForm.host}:554`);
      } else {
        setNvrSelected(new Set(result.channels.map(c => c.channel)));
        toast.success(`Found ${result.channels.length} channels — select which to import`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setNvrScanning(false);
    }
  }

  function toggleNvrChannel(ch: number) {
    setNvrSelected(prev => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch); else next.add(ch);
      return next;
    });
  }

  function toggleAllNvr() {
    if (!nvrResult) return;
    setNvrSelected(prev =>
      prev.size === nvrResult.channels.length
        ? new Set()
        : new Set(nvrResult.channels.map(c => c.channel))
    );
  }

  async function handleNvrImport() {
    if (!nvrIntersectionId || !nvrResult) return;
    setNvrImporting(true);
    const toImport = nvrResult.channels.filter(c => nvrSelected.has(c.channel));
    try {
      await Promise.all(
        toImport.map(c =>
          cctvsApi.create({
            name: `Ch${c.channel} (${nvrForm.host})`,
            rtsp_url: c.rtsp_url,
            intersection_id: Number(nvrIntersectionId),
          })
        )
      );
      toast.success(`Imported ${toImport.length} camera${toImport.length !== 1 ? 's' : ''}`);
      setShowNvrModal(false);
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setNvrImporting(false);
    }
  }

  function openCsvModal() {
    setCsvFile(null);
    setCsvResult(null);
    setShowCsvModal(true);
  }

  async function handleCsvImport() {
    if (!csvFile) return;
    setCsvImporting(true);
    try {
      const result = await intersectionsApi.importCsv(csvFile);
      setCsvResult(result);
      if (result.created_cameras.length > 0 || result.created_intersections.length > 0) {
        toast.success(
          `Imported ${result.created_cameras.length} camera${result.created_cameras.length !== 1 ? 's' : ''} ` +
          `across ${result.created_intersections.length} new intersection${result.created_intersections.length !== 1 ? 's' : ''}`
        );
        load();
      } else {
        toast.info('Nothing new to import');
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCsvImporting(false);
    }
  }

  async function handleDiscover() {
    setDiscovering(true);
    setDiscovered([]);
    setShowDiscovery(true);
    try {
      const results = await request<DiscoveredCamera[]>('/cctvs/discover');
      setDiscovered(results);
      if (results.length === 0) {
        toast.info('No ONVIF cameras found on this network segment');
      } else {
        toast.success(`Found ${results.length} camera${results.length !== 1 ? 's' : ''}`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }

  async function importCamera(cam: DiscoveredCamera) {
    if (!importIntersectionId) {
      toast.error('Select an intersection first');
      return;
    }
    setImporting(cam.address);
    try {
      await cctvsApi.create({
        name: `Camera ${cam.address}`,
        rtsp_url: cam.rtsp_url ?? `rtsp://${cam.address}:554/`,
        intersection_id: Number(importIntersectionId),
      });
      toast.success(`Imported camera at ${cam.address}`);
      setDiscovered(prev => prev.filter(d => d.address !== cam.address));
      load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(null);
    }
  }

  const intersectionMap = new Map(intersections.map(i => [i.id, i]));

  let online = 0, reconnecting = 0, offline = 0;
  for (const c of cctvs) {
    if (c.status === 'online') online++;
    else if (c.status === 'reconnecting') reconnecting++;
    else if (c.status === 'offline') offline++;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Cameras</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleDiscover} disabled={discovering}>
            {discovering
              ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
              : <ScanSearch className="size-3.5 mr-1.5" />
            }
            Discover (ONVIF)
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setNvrForm(NVR_FORM_DEFAULT); setNvrResult(null); setNvrSelected(new Set()); setShowNvrModal(true); }}>
            <Server className="size-3.5 mr-1.5" />
            Scan NVR
          </Button>
          <Button variant="outline" size="sm" onClick={openCsvModal}>
            <Upload className="size-3.5 mr-1.5" />
            Import CSV
          </Button>
          <Button onClick={openCreate} size="sm">
            <Plus className="size-3.5 mr-1.5" />
            Add Camera
          </Button>
        </div>
      </div>

      {/* Status strip */}
      <div className="flex gap-6 rounded-lg border border-border bg-card px-5 py-3 text-sm">
        {[
          { label: 'Online', count: online, color: 'text-emerald-500' },
          { label: 'Reconnecting', count: reconnecting, color: 'text-amber-500' },
          { label: 'Offline', count: offline, color: 'text-destructive' },
        ].map(({ label, count, color }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={cn('text-lg font-bold tabular-nums', color)}>{count}</span>
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      {/* Camera table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : cctvs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <Camera className="size-10 opacity-30" />
              <p className="text-sm">No cameras configured</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Intersection</TableHead>
                  <TableHead>RTSP URL</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cctvs.map(c => {
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell><StatusBadge status={c.status} lastError={c.last_error} /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">{intersectionMap.get(c.intersection_id)?.name ?? '-'}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{c.rtsp_url}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 justify-end">
                          <Link to={`/cameras/${c.id}`}>
                            <Button variant="ghost" size="icon" className="size-7" aria-label={`View regions for ${c.name}`}>
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                            </Button>
                          </Link>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Edit ${c.name}`} onClick={() => openEdit(c)}>
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" aria-label={`Delete ${c.name}`}>
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {c.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will remove the camera and all associated regions and detections.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDelete(c)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ONVIF discovery results */}
      {showDiscovery && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScanSearch className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">ONVIF Discovery</CardTitle>
                {discovering && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowDiscovery(false)}>Dismiss</Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Intersection selector for bulk import */}
            {discovered.length > 0 && (
              <div className="flex items-center gap-3">
                <Label className="text-xs shrink-0">Import to intersection:</Label>
                <Select value={importIntersectionId} onValueChange={setImportIntersectionId}>
                  <SelectTrigger className="h-8 text-xs max-w-[200px]">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {intersections.map(i => (
                      <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {discovering && discovered.length === 0 && (
              <p className="text-sm text-muted-foreground">Scanning network for ONVIF cameras…</p>
            )}

            {!discovering && discovered.length === 0 && (
              <p className="text-sm text-muted-foreground">No ONVIF cameras found on this subnet.</p>
            )}

            {discovered.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>IP Address</TableHead>
                    <TableHead>RTSP URL</TableHead>
                    <TableHead>Management</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {discovered.map(cam => (
                    <TableRow key={cam.address}>
                      <TableCell className="font-mono text-sm">{cam.address}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{cam.rtsp_url ?? '-'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {cam.xaddrs.length > 0 ? cam.xaddrs[0] : '-'}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={importing === cam.address || !importIntersectionId}
                          onClick={() => importCamera(cam)}
                        >
                          {importing === cam.address
                            ? <Loader2 className="size-3.5 mr-1 animate-spin" />
                            : <Download className="size-3.5 mr-1" />
                          }
                          Import
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Add/Edit modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Camera' : 'Add Camera'}</DialogTitle>
          </DialogHeader>
          <Separator />
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="camera-name">Name</Label>
              <Input id="camera-name" name="camera-name" autoComplete="off" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Cam 1 North…" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="camera-rtsp">RTSP URL</Label>
              <Input id="camera-rtsp" name="rtsp-url" autoComplete="off" value={form.rtsp_url} onChange={e => setForm({ ...form, rtsp_url: e.target.value })} placeholder="rtsp://…" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Intersection</Label>
              <Select value={form.intersection_id} onValueChange={v => setForm({ ...form, intersection_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select intersection…" /></SelectTrigger>
                <SelectContent>
                  {intersections.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !form.name || !form.rtsp_url || !form.intersection_id}>
              {saving && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* NVR scan modal */}
      <Dialog open={showNvrModal} onOpenChange={open => { setShowNvrModal(open); if (!open) setNvrResult(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Scan NVR Channels</DialogTitle>
          </DialogHeader>
          <Separator />

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label>NVR IP Address</Label>
                <Input
                  value={nvrForm.host}
                  onChange={e => setNvrForm({ ...nvrForm, host: e.target.value })}
                  placeholder="172.16.57.4"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Username</Label>
                <Input
                  value={nvrForm.username}
                  onChange={e => setNvrForm({ ...nvrForm, username: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Password</Label>
                <Input
                  type="password"
                  value={nvrForm.password}
                  onChange={e => setNvrForm({ ...nvrForm, password: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Max Channels</Label>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  value={nvrForm.maxChannels}
                  onChange={e => setNvrForm({ ...nvrForm, maxChannels: Math.min(64, Math.max(1, Number(e.target.value))) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Stream quality</Label>
                <Select value={String(nvrForm.subtype)} onValueChange={v => setNvrForm({ ...nvrForm, subtype: Number(v) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Sub-stream (low-res, recommended)</SelectItem>
                    <SelectItem value="0">Main stream (high-res)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleNvrScan} disabled={nvrScanning || !nvrForm.host}>
              {nvrScanning
                ? <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                : <Server className="size-3.5 mr-1.5" />
              }
              {nvrScanning ? 'Scanning…' : 'Scan'}
            </Button>
          </div>

          {nvrResult?.reachable && nvrResult.channels.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{nvrResult.channels.length} channels · {nvrSelected.size} selected</span>
                  <Button variant="ghost" size="sm" onClick={toggleAllNvr} className="h-7 text-xs">
                    {nvrSelected.size === nvrResult.channels.length ? 'Deselect all' : 'Select all'}
                  </Button>
                </div>

                <ScrollArea className="h-44 rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>Channel</TableHead>
                        <TableHead>RTSP URL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {nvrResult.channels.map(c => (
                        <TableRow
                          key={c.channel}
                          className="cursor-pointer"
                          onClick={() => toggleNvrChannel(c.channel)}
                        >
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={nvrSelected.has(c.channel)}
                              onChange={() => toggleNvrChannel(c.channel)}
                              onClick={e => e.stopPropagation()}
                              className="size-3.5 accent-primary"
                            />
                          </TableCell>
                          <TableCell className="font-medium">Ch {c.channel}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground max-w-[240px] truncate">
                            {c.rtsp_url}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>

                <div className="flex items-center gap-3">
                  <Label className="text-xs shrink-0">Import to:</Label>
                  <Select value={nvrIntersectionId} onValueChange={setNvrIntersectionId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select intersection…" />
                    </SelectTrigger>
                    <SelectContent>
                      {intersections.map(i => (
                        <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNvrModal(false)}>Cancel</Button>
            {nvrResult?.reachable && nvrSelected.size > 0 && (
              <Button onClick={handleNvrImport} disabled={nvrImporting || !nvrIntersectionId}>
                {nvrImporting && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
                Import {nvrSelected.size} camera{nvrSelected.size !== 1 ? 's' : ''}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV Import modal */}
      <Dialog open={showCsvModal} onOpenChange={open => { setShowCsvModal(open); if (!open) setCsvResult(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Cameras from CSV</DialogTitle>
          </DialogHeader>
          <Separator />

          {!csvResult ? (
            <div className="flex flex-col gap-4 py-1">
              <p className="text-sm text-muted-foreground">
                Upload a CSV to bulk-create intersections and cameras.
                Intersections are matched by name — existing ones are reused.
              </p>

              <div className="rounded-md border border-dashed border-border p-4 flex flex-col items-center gap-3 text-center">
                <FileText className="size-8 text-muted-foreground opacity-50" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">
                    {csvFile ? csvFile.name : 'Choose a CSV file'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Columns: intersection_name, latitude, longitude, camera_name, rtsp_url
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Upload className="size-3.5 mr-1.5" />
                    {csvFile ? 'Change file' : 'Browse'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={downloadTemplate}>
                    <Download className="size-3.5 mr-1.5" />
                    Download template
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={e => setCsvFile(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-1">
              <div className="flex gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-emerald-500">
                  <CheckCircle2 className="size-4" />
                  {csvResult.created_intersections.length} intersection{csvResult.created_intersections.length !== 1 ? 's' : ''} created
                </span>
                <span className="flex items-center gap-1.5 text-emerald-500">
                  <CheckCircle2 className="size-4" />
                  {csvResult.created_cameras.length} camera{csvResult.created_cameras.length !== 1 ? 's' : ''} created
                </span>
              </div>

              {csvResult.errors.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium text-destructive flex items-center gap-1">
                    <XCircle className="size-3.5" />
                    {csvResult.errors.length} warning{csvResult.errors.length !== 1 ? 's' : ''}
                  </p>
                  <ScrollArea className="h-32 rounded-md border border-border bg-muted/30 p-2">
                    {csvResult.errors.map((e, i) => (
                      <p key={i} className="text-xs text-muted-foreground font-mono">{e}</p>
                    ))}
                  </ScrollArea>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCsvModal(false)}>
              {csvResult ? 'Close' : 'Cancel'}
            </Button>
            {!csvResult && (
              <Button onClick={handleCsvImport} disabled={!csvFile || csvImporting}>
                {csvImporting && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
                Import
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
