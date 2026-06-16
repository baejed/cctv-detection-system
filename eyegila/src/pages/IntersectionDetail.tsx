import { useEffect, useRef, useState, useContext, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { intersectionsApi } from '@/services/intersections';
import { cctvsApi } from '@/services/cctvs';
import { AuthContext } from '@/context/AuthContext';
import { triggerUnauthorized } from '@/services/api';
import type { Intersection, CCTV, AggregationRow } from '@/types';
import type { SSEStatus } from '@/hooks/useSSE';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MonitorPlay, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const WS_BASE = import.meta.env.DEV
  ? 'ws://localhost:8000'
  : `ws://${window.location.host}/api`;

interface FeedProps {
  cam: CCTV | null;
  count: number;
}

function LiveCameraFeed({ cam, count }: FeedProps) {
  const { token }    = useContext(AuthContext);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');

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
    setStatus('connecting');
    const ws = new WebSocket(`${WS_BASE}/cctvs/${cam.id}/ws?token=${token ?? ''}&overlay=true`);
    ws.binaryType = 'arraybuffer';
    ws.onopen  = () => setStatus('live');
    ws.onerror = () => setStatus('error');
    ws.onclose = (e: CloseEvent) => {
      if (e.code === 4001) { triggerUnauthorized(); return; }
      setStatus('error');
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
    return () => ws.close();
  }, [cam?.id, token]);

  return (
    <div ref={containerRef} className="relative bg-zinc-950 overflow-hidden">
      {cam && (
        <>
          <canvas ref={canvasRef} className="absolute inset-0" />
          <span className={cn(
            'absolute top-2 left-2 size-1.5 rounded-full z-10',
            status === 'live'       ? 'bg-emerald-400' :
            status === 'connecting' ? 'bg-amber-400 animate-pulse' :
                                      'bg-red-400',
          )} />
          <span className="absolute bottom-2 left-2 text-[9px] text-white/60 leading-none z-10 drop-shadow">
            {cam.name}
          </span>
          {count > 0 && (
            <span className="absolute bottom-2 right-2 text-[10px] text-emerald-400 font-semibold tabular-nums leading-none z-10 drop-shadow">
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
  const [loading,      setLoading]      = useState(true);

  const load = useCallback(async () => {
    try {
      const [inter, allCams] = await Promise.all([
        intersectionsApi.get(interId),
        cctvsApi.list(),
      ]);
      setIntersection(inter);
      setCameras(allCams.filter(c => c.intersection_id === interId));
    } catch {
      toast.error('Failed to load intersection');
    } finally {
      setLoading(false);
    }
  }, [interId]);

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
        <h1 className="flex-1 text-xl font-semibold tracking-tight truncate min-w-0">
          {loading ? '…' : (intersection?.name ?? 'Intersection')}
        </h1>
        <div className="flex rounded-md border border-border overflow-hidden shrink-0">
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
          />
        ))}
      </div>
    </div>
  );
}
