import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '@/context/AuthContext';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { intersectionsApi } from '@/services/intersections';
import { request } from '@/services/api';
import type { CCTV, Street, Region, RegionPoint, Intersection } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { ArrowLeft, Plus, Trash2, Loader2, Pencil, Check, X, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

const REGION_COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899',
];

interface RegionWithName extends Region {
  streetName?: string;
  colorIndex: number;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const WS_BASE = import.meta.env.DEV ? 'ws://localhost:8000' : `ws://${window.location.host}/api`;


// ── Inline editable street row ────────────────────────────────────────────────
function StreetRow({
  street,
  onRenamed,
  onDeleted,
}: {
  street: Street;
  onRenamed: (id: number, name: string) => void;
  onDeleted: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(street.name);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!value.trim() || value === street.name) { setEditing(false); return; }
    setSaving(true);
    try {
      await streetsApi.update(street.id, { name: value.trim() });
      onRenamed(street.id, value.trim());
      setEditing(false);
    } catch {
      toast.error('Failed to rename street');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 py-1">
        <Input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          className="h-7 text-xs flex-1"
        />
        <Button size="icon" variant="ghost" className="size-7" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(false)}>
          <X className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 py-1 group">
      <span className="text-xs flex-1 truncate">{street.name}</span>
      <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setEditing(true)}>
        <Pencil className="size-3" />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive">
            <Trash2 className="size-3" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{street.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Regions linked to this street will lose their street association.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDeleted(street.id)} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function CameraDetailPage() {
  const { id } = useParams<{ id: string }>();
  const cctv_id = Number(id);
  const { token } = useContext(AuthContext);

  const [cctv, setCctv] = useState<CCTV | null>(null);
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [streets, setStreets] = useState<Street[]>([]);
  const [regions, setRegions] = useState<RegionWithName[]>([]);
  const [loading, setLoading] = useState(true);

  // Region drawing
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<RegionPoint[]>([]);
  const [selectedStreet, setSelectedStreet] = useState<string>('');
  const [selectedDirection, setSelectedDirection] = useState<string>('unknown');
  const [saving, setSaving] = useState(false);

  const redrawRef = useRef<() => void>(() => {});

  // Intersection inline edit
  const [editingIntersection, setEditingIntersection] = useState(false);
  const [intersectionName, setIntersectionName] = useState('');
  const [savingIntersection, setSavingIntersection] = useState(false);

  // Add street
  const [newStreetName, setNewStreetName] = useState('');
  const [addingStreet, setAddingStreet] = useState(false);

  // Canvas / stream
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'error'>('connecting');

  async function loadData() {
    try {
      const [cam, allStreets] = await Promise.all([cctvsApi.get(cctv_id), streetsApi.list()]);
      setCctv(cam);
      const camStreets = allStreets.filter(s => s.intersection_id === cam.intersection_id);
      setStreets(camStreets);

      if (cam.intersection_id) {
        const inter = await intersectionsApi.get(cam.intersection_id);
        setIntersection(inter);
        setIntersectionName(inter.name);
      }

      const allRegions: Region[] = await request('/regions/');
      const camRegions = allRegions.filter(r => r.cctv_id === cctv_id);
      setRegions(camRegions.map((r, i) => ({
        ...r,
        streetName: allStreets.find(s => s.id === r.street_id)?.name,
        colorIndex: i % REGION_COLORS.length,
      })));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load camera');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [cctv_id]);

  // Container size → canvas dimensions
  // Depends on `loading` so it re-runs once the container div actually mounts
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // WebSocket → video canvas (server burns boxes onto frames before sending)
  useEffect(() => {
    if (loading) return;
    setWsStatus('connecting');
    const ws = new WebSocket(`${WS_BASE}/cctvs/${cctv_id}/ws?token=${token ?? ''}&overlay=true`);
    ws.binaryType = 'arraybuffer';
    ws.onopen  = () => setWsStatus('live');
    ws.onerror = () => setWsStatus('error');
    ws.onclose = () => setWsStatus('error');
    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const canvas = videoCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const blob = new Blob([event.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const cw = canvas.width, ch = canvas.height;
        const scale = Math.min(cw / img.width, ch / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, dx, dy, dw, dh);
        URL.revokeObjectURL(url);
        // trigger overlay redraw after each new frame
        redrawRef.current();
      };
      img.src = url;
    };
    return () => ws.close();
  }, [cctv_id, loading]);

  // Sync canvas internal resolution to container size, scaled by devicePixelRatio for sharp rendering
  useEffect(() => {
    if (!canvasSize) return;
    const dpr = window.devicePixelRatio || 1;
    const vc = videoCanvasRef.current;
    const oc = overlayCanvasRef.current;
    if (vc) { vc.width = canvasSize.w * dpr; vc.height = canvasSize.h * dpr; }
    if (oc) { oc.width = canvasSize.w * dpr; oc.height = canvasSize.h * dpr; }
  }, [canvasSize]);

  // Redraw region overlay (boxes are now burned into video frames server-side)
  const redrawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !canvasSize) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = canvasSize;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // saved region polygons
    for (const region of regions) {
      if (region.region_points.length < 2) continue;
      const color = REGION_COLORS[region.colorIndex];
      ctx.beginPath();
      ctx.moveTo(region.region_points[0].x * w, region.region_points[0].y * h);
      for (const p of region.region_points.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(color, 0.22);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      const cx = region.region_points.reduce((a, p) => a + p.x, 0) / region.region_points.length;
      const cy = region.region_points.reduce((a, p) => a + p.y, 0) / region.region_points.length;
      ctx.fillStyle = color;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      const dirLabel = region.direction !== 'unknown' ? ` (${region.direction})` : '';
      ctx.fillText((region.streetName ?? `Region ${region.id}`) + dirLabel, cx * w, cy * h);
    }

    // in-progress polygon
    if (drawing && points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(points[0].x * w, points[0].y * h);
      for (const p of points.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < points.length; i++) {
        ctx.beginPath();
        ctx.arc(points[i].x * w, points[i].y * h, i === 0 ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#22c55e' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [drawing, points, regions, canvasSize]);

  useEffect(() => {
    redrawRef.current = redrawOverlay;
    redrawOverlay();
  }, [redrawOverlay]);

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawing || !canvasSize) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (points.length >= 3 && Math.hypot(x - points[0].x, y - points[0].y) < 0.015) {
      finishPolygon(); return;
    }
    setPoints(prev => [...prev, { x, y }]);
  }

  async function finishPolygon() {
    if (!selectedStreet) { toast.error('Select a street first'); return; }
    if (points.length < 3) { toast.error('Need at least 3 points'); return; }
    setSaving(true);
    try {
      await request('/regions/', {
        method: 'POST',
        body: JSON.stringify({
          cctv_id,
          street_id: Number(selectedStreet),
          direction: selectedDirection,
          region_points: points,
        }),
      });
      toast.success('Region saved');
      setPoints([]); setDrawing(false);
      await loadData();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  }

  async function handleDeleteRegion(regionId: number) {
    try {
      await request(`/regions/${regionId}`, { method: 'DELETE' });
      toast.success('Region deleted');
      await loadData();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function saveIntersectionName() {
    if (!intersection || !intersectionName.trim()) return;
    setSavingIntersection(true);
    try {
      await intersectionsApi.update(intersection.id, { name: intersectionName.trim() });
      setIntersection(prev => prev ? { ...prev, name: intersectionName.trim() } : prev);
      setEditingIntersection(false);
      toast.success('Intersection renamed');
    } catch { toast.error('Failed to rename intersection'); }
    finally { setSavingIntersection(false); }
  }

  async function handleAddStreet() {
    if (!newStreetName.trim() || !cctv?.intersection_id) return;
    setAddingStreet(true);
    try {
      const s = await streetsApi.create({ intersection_id: cctv.intersection_id, name: newStreetName.trim() });
      setStreets(prev => [...prev, s]);
      setNewStreetName('');
      toast.success(`Street "${s.name}" added`);
    } catch { toast.error('Failed to add street'); }
    finally { setAddingStreet(false); }
  }

  async function handleDeleteStreet(id: number) {
    try {
      await streetsApi.delete(id);
      setStreets(prev => prev.filter(s => s.id !== id));
      if (selectedStreet === String(id)) setSelectedStreet('');
      toast.success('Street deleted');
      await loadData();
    } catch { toast.error('Failed to delete street'); }
  }

  function handleStreetRenamed(id: number, name: string) {
    setStreets(prev => prev.map(s => s.id === id ? { ...s, name } : s));
    setRegions(prev => prev.map(r => r.street_id === id ? { ...r, streetName: name } : r));
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/cameras">
          <Button variant="ghost" size="icon" className="size-8"><ArrowLeft className="size-4" /></Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{cctv?.name ?? 'Camera'}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Live stream · region editor</p>
        </div>
        {cctv && (
          <Badge variant="outline" className={cn(
            'ml-2',
            cctv.status === 'online' && 'border-emerald-500/40 text-emerald-600 bg-emerald-50',
            cctv.status === 'offline' && 'border-destructive/40 text-destructive',
          )}>
            {cctv.status}
          </Badge>
        )}
        <Badge variant="outline" className={cn(
          'text-[10px]',
          wsStatus === 'live'       && 'border-emerald-500/40 text-emerald-600',
          wsStatus === 'connecting' && 'border-amber-500/40 text-amber-500',
          wsStatus === 'error'      && 'border-destructive/40 text-destructive',
        )}>
          {wsStatus === 'live' ? '● live' : wsStatus === 'connecting' ? '○ connecting' : '✕ no stream'}
        </Badge>
      </div>

      {loading ? (
        <Skeleton className="h-80 w-full rounded-lg" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          {/* ── Video + overlay ── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Live Stream</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                ref={containerRef}
                className="relative overflow-hidden rounded-md bg-black"
                style={{ aspectRatio: '16/9' }}
              >
                <canvas ref={videoCanvasRef} className="absolute inset-0 w-full h-full" />
                <canvas
                  ref={overlayCanvasRef}
                  className="absolute inset-0 w-full h-full"
                  style={{ cursor: drawing ? 'crosshair' : 'default' }}
                  onClick={handleCanvasClick}
                  onDoubleClick={() => { if (drawing && points.length >= 3) finishPolygon(); }}
                />
                {wsStatus === 'error' && (
                  <div className="absolute inset-0 flex items-center justify-center text-white/50 text-sm pointer-events-none">
                    Stream unavailable
                  </div>
                )}
              </div>

              {drawing && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="text-green-600 font-medium">Drawing</span>
                  <span>· click to add · dbl-click or click ① to close</span>
                  <div className="ml-auto flex gap-2">
                    {points.length >= 3 && (
                      <Button size="sm" variant="outline" onClick={finishPolygon} disabled={saving}>
                        {saving && <Loader2 className="size-3 mr-1 animate-spin" />}
                        Save region
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { setDrawing(false); setPoints([]); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Right panel ── */}
          <div className="flex flex-col gap-4">

            {/* Intersection */}
            {intersection && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <MapPin className="size-3.5 text-muted-foreground" />
                    <CardTitle className="text-sm">Intersection</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {editingIntersection ? (
                    <div className="flex gap-1">
                      <Input
                        autoFocus
                        value={intersectionName}
                        onChange={e => setIntersectionName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveIntersectionName(); if (e.key === 'Escape') setEditingIntersection(false); }}
                        className="h-7 text-xs"
                      />
                      <Button size="icon" variant="ghost" className="size-7" onClick={saveIntersectionName} disabled={savingIntersection}>
                        {savingIntersection ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-emerald-600" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7" onClick={() => { setEditingIntersection(false); setIntersectionName(intersection.name); }}>
                        <X className="size-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 group">
                      <span className="text-sm font-medium flex-1">{intersection.name}</span>
                      <Button size="icon" variant="ghost" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setEditingIntersection(true)}>
                        <Pencil className="size-3" />
                      </Button>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {intersection.latitude.toFixed(5)}, {intersection.longitude.toFixed(5)}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Streets */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Streets ({streets.length})</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {streets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No streets yet - add one below.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {streets.map(s => (
                      <StreetRow
                        key={s.id}
                        street={s}
                        onRenamed={handleStreetRenamed}
                        onDeleted={handleDeleteStreet}
                      />
                    ))}
                  </div>
                )}
                <Separator />
                <div className="flex gap-1.5">
                  <Input
                    placeholder="New street name…"
                    value={newStreetName}
                    onChange={e => setNewStreetName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddStreet(); }}
                    className="h-7 text-xs"
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2.5"
                    onClick={handleAddStreet}
                    disabled={!newStreetName.trim() || addingStreet || !cctv?.intersection_id}
                  >
                    {addingStreet ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Draw region */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Draw Region</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Link to street</Label>
                  <Select value={selectedStreet} onValueChange={setSelectedStreet}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={streets.length ? 'Select street…' : 'Add a street first'} />
                    </SelectTrigger>
                    <SelectContent>
                      {streets.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Direction</Label>
                  <Select value={selectedDirection} onValueChange={setSelectedDirection}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unknown">Unknown</SelectItem>
                      <SelectItem value="inbound">Inbound (towards intersection)</SelectItem>
                      <SelectItem value="outbound">Outbound (away from intersection)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!drawing ? (
                  <Button size="sm" onClick={() => { setDrawing(true); setPoints([]); }} disabled={!selectedStreet || !canvasSize}>
                    <Plus className="size-3.5 mr-1" />
                    Draw polygon
                  </Button>
                ) : (
                  <p className="text-xs text-green-600">
                    {points.length} pt{points.length !== 1 ? 's' : ''} placed.
                    {points.length < 3 ? ` Need ${3 - points.length} more.` : ' Close to save.'}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Regions list */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Regions ({regions.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {regions.length === 0 ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">No regions yet.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {regions.map(r => (
                      <div key={r.id} className="flex items-center gap-2 px-4 py-2">
                        <div className="size-3 rounded-sm shrink-0" style={{ backgroundColor: REGION_COLORS[r.colorIndex] }} />
                        <span className="text-xs flex-1 truncate">{r.streetName ?? `Region ${r.id}`}</span>
                        {r.direction !== 'unknown' && (
                          <Badge variant="outline" className={cn(
                            'text-[9px] px-1 h-4',
                            r.direction === 'inbound' && 'border-blue-500/40 text-blue-600',
                            r.direction === 'outbound' && 'border-amber-500/40 text-amber-600',
                          )}>
                            {r.direction === 'inbound' ? '↓ in' : '↑ out'}
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">{r.region_points.length}pt</span>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-6 text-destructive hover:text-destructive">
                              <Trash2 className="size-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete region?</AlertDialogTitle>
                              <AlertDialogDescription>Removes this region and all detection links.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDeleteRegion(r.id)} className="bg-destructive text-destructive-foreground">
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
