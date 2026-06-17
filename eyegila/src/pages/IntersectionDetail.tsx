import { useEffect, useRef, useState, useContext, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { cctvsApi } from '@/services/cctvs';
import { streetsApi } from '@/services/streets';
import { recommendationsApi, type RecommendationResponse } from '@/services/recommendations';
import { AuthContext } from '@/context/AuthContext';
import { triggerUnauthorized } from '@/services/api';
import type { Intersection, CCTV, Street, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { SettingsSheet } from '@/components/IntersectionSettingsSheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, MonitorPlay, TrendingUp, Settings2, RefreshCw, Loader2, RotateCcw } from 'lucide-react';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from '@/components/recommendations/statusBucket';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const WS_BASE = import.meta.env.DEV
  ? 'ws://localhost:8000'
  : `ws://${window.location.host}/api`;

interface FeedProps {
  cam: CCTV | null;
  count: number;
  onCameraClick: (camId: number) => void;
}

function LiveCameraFeed({ cam, count, onCameraClick }: FeedProps) {
  const { token }    = useContext(AuthContext);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  // Bump to force the WS effect below to tear down + reopen on demand.
  // Used by the reload button when boxes have stopped appearing - kicks the
  // worker's retry signal AND throws away any stale server-side capture
  // subscription this socket might be stuck on.
  const [reconnectKey, setReconnectKey] = useState(0);
  const [reloading, setReloading] = useState(false);

  async function handleReload(e: React.MouseEvent) {
    e.stopPropagation();  // don't trigger the tile's onCameraClick
    if (!cam || reloading) return;
    setReloading(true);
    try {
      await cctvsApi.retry(cam.id);
    } catch {
      // worker nudge is best-effort; reconnect still proceeds
    }
    setReconnectKey(k => k + 1);
    setReloading(false);
  }

  // Keep canvas pixel buffer in sync with container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      canvas.width        = Math.round(w * dpr);
      canvas.height       = Math.round(h * dpr);
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // WebSocket → canvas
  useEffect(() => {
    if (!cam) return;
    // Don't open the socket without a token - the server would close it with
    // 4001 and the unauth handler would fire a "Session expired" toast. Wait
    // for the token to arrive (effect re-runs on token change) instead.
    if (!token) return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Track the most-recently created socket so that reconnected sockets (created
    // by the onclose retry timer) are also closed when the component unmounts.
    // Capturing only the return value of the first connect() call misses any WS
    // instances created by subsequent retries.
    let activeWs: WebSocket | null = null;

    function connect() {
      if (stopped) return;
      setStatus('connecting');
      const ws = new WebSocket(`${WS_BASE}/cctvs/${cam!.id}/ws?token=${token}&overlay=true`);
      activeWs = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen  = () => setStatus('live');
      ws.onerror = () => setStatus('error');
      ws.onclose = (e: CloseEvent) => {
        if (e.code === 4001) { triggerUnauthorized(); return; }
        setStatus('error');
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const blob = new Blob([e.data], { type: 'image/jpeg' });
        const url  = URL.createObjectURL(blob);
        const img  = new Image();
        img.onload = () => {
          const cw = canvas.width, ch = canvas.height;
          const scale = Math.min(cw / img.width, ch / img.height);
          const dw = img.width * scale, dh = img.height * scale;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      };
    }

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      activeWs?.close();
    };
  }, [cam?.id, token, reconnectKey]);

  return (
    <div
      ref={containerRef}
      className={cn('relative bg-zinc-950 overflow-hidden', cam && 'cursor-pointer group')}
      onClick={() => cam && onCameraClick(cam.id)}
    >
      {cam && (
        <>
          <canvas ref={canvasRef} className="absolute inset-0" />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors z-10 pointer-events-none" />
          <span className={cn(
            'absolute top-2 left-2 size-1.5 rounded-full z-20',
            status === 'live'       ? 'bg-emerald-400' :
            status === 'connecting' ? 'bg-amber-400 animate-pulse' :
                                      'bg-red-400',
          )} />
          <button
            type="button"
            onClick={handleReload}
            disabled={reloading}
            title="Reload stream - nudges the worker to reconnect and reopens the live socket"
            aria-label="Reload camera stream"
            className="absolute top-1.5 right-1.5 z-30 flex items-center justify-center size-6 rounded-md bg-black/50 hover:bg-black/70 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-100 disabled:cursor-wait"
          >
            {reloading
              ? <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              : <RotateCcw className="size-3" aria-hidden="true" />}
          </button>
          <span className="absolute bottom-2 left-2 text-[9px] text-white/60 leading-none z-20 drop-shadow">
            {cam.name}
          </span>
          {count > 0 && (
            <span className="absolute bottom-2 right-2 text-[10px] text-emerald-400 font-semibold tabular-nums leading-none z-20 drop-shadow">
              {count}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function IntersectionDetailPage() {
  const { id }      = useParams<{ id: string }>();
  const navigate    = useNavigate();
  const { sseData } = useOutletContext<{ sseData: AggregationRow[] | null; sseStatus: SSEStatus }>();

  const interId = Number(id);

  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [cameras,      setCameras]      = useState<CCTV[]>([]);
  const [streets,      setStreets]      = useState<Street[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [rec,          setRec]          = useState<RecommendationResponse | null>(null);
  const [generating,   setGenerating]   = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [inter, allCams, allStreets] = await Promise.all([
        intersectionsApi.get(interId),
        cctvsApi.list(),
        streetsApi.list().catch(() => [] as Street[]),
      ]);
      setIntersection(inter);
      setCameras(allCams.filter(c => c.intersection_id === interId));
      setStreets(allStreets.filter(s => s.intersection_id === interId));
      // latest() returns null when no recommendation exists yet. Any fetch
      // error (including network failures) is absorbed here so that a missing
      // badge never blocks the rest of the page from loading. Auth errors are
      // already handled inside request() before the error is thrown.
      const r = await recommendationsApi.latest(interId).catch(() => null);
      setRec(r);
    } catch {
      toast.error('Failed to load intersection');
    } finally {
      setLoading(false);
    }
  }, [interId]);

  async function generate() {
    setGenerating(true);
    try {
      await recommendationsApi.generate(interId);
      toast.success('Analysis complete');
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => { load(); }, [load]);

  const liveCount = useMemo(() => {
    let total = 0;
    for (const row of sseData ?? []) {
      if (row.intersection_id === interId) total += row.count;
    }
    return total;
  }, [sseData, interId]);

  const slots: (CCTV | null)[] = [
    cameras[0] ?? null,
    cameras[1] ?? null,
    cameras[2] ?? null,
    cameras[3] ?? null,
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => navigate('/')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">
            {loading ? '…' : (intersection?.name ?? 'Intersection')}
          </h1>
          {rec && (
            <Badge className={cn('shrink-0 text-[10px]', BUCKET_BADGE_CLASS[statusBucket(rec)])}>
              {BUCKET_LABEL[statusBucket(rec)]}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            onClick={generate}
            disabled={generating}
            title="Run warrant analysis"
          >
            {generating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {generating ? 'Analysing…' : 'Analyse'}
          </Button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Settings"
          >
            <Settings2 className="size-4" />
          </button>
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-foreground text-background"
            >
              <MonitorPlay className="size-3" />
              Live
            </button>
            <button
              type="button"
              onClick={() => navigate(`/timing/${id}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border-l border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              <TrendingUp className="size-3" />
              Timing
            </button>
          </div>
        </div>
      </div>

      {/* 2×2 live camera grid */}
      <div
        className="grid grid-cols-2 gap-px bg-border rounded-xl overflow-hidden"
        style={{ aspectRatio: '16/9' }}
      >
        {slots.map((cam, i) => (
          <LiveCameraFeed
            key={cam?.id ?? `empty-${i}`}
            cam={cam}
            count={liveCount}
            onCameraClick={camId => navigate(`/intersections/${id}/cameras/${camId}`)}
          />
        ))}
      </div>

      <SettingsSheet
        inter={intersection}
        streets={streets}
        cameras={cameras}
        rec={rec}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRefresh={load}
      />
    </div>
  );
}
