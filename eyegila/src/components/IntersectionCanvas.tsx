import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SimulationChunk } from '@/services/simulation';
import type { TimingChunk } from '@/services/timing';

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444'];
const DIR_LABELS = ['N', 'E', 'S', 'W'];
const SPEEDS = [
  { label: '1×', sps: 60 },
  { label: '5×', sps: 300 },
  { label: '10×', sps: 600 },
];
const SIM_DURATION = 3600;

type VehicleType = 'MC' | 'CAR' | 'JEP' | 'BUS' | 'TRUCK';

interface Vehicle {
  id: number;
  type: VehicleType;
  approach: number;
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
  gap: number;
}

// Dimensions in canvas units (length × width along/across direction of travel)
const VEHICLE_PARAMS: Record<VehicleType, { length: number; width: number; speed: number; minGap: number }> = {
  MC:    { length: 14, width: 8,  speed: 90, minGap: 8  },
  CAR:   { length: 18, width: 10, speed: 70, minGap: 12 },
  JEP:   { length: 22, width: 12, speed: 55, minGap: 16 },
  BUS:   { length: 28, width: 14, speed: 45, minGap: 20 },
  TRUCK: { length: 28, width: 14, speed: 45, minGap: 20 },
};

// Deterministic type sequence: ~50% MC, ~30% CAR, ~10% JEP, ~5% BUS, ~5% TRUCK
const TYPE_SEQUENCE: VehicleType[] = ['MC', 'CAR', 'MC', 'CAR', 'MC', 'JEP', 'MC', 'CAR', 'BUS', 'TRUCK'];

function computeGreenState(
  ids: string[],
  cycleLength: number,
  splits: Record<string, number>,
  simTime: number,
): boolean[] {
  const n = ids.length;
  const tInCycle = simTime % cycleLength;
  const out = new Array<boolean>(n).fill(false);
  let elapsed = 0;
  for (let i = 0; i < n; i++) {
    const g = splits[ids[i]] ?? cycleLength / n;
    if (tInCycle >= elapsed && tInCycle < elapsed + g) {
      out[i] = true;
      break;
    }
    elapsed += g;
  }
  return out;
}

function placeVehicles(
  ids: string[],
  series: Record<string, number[]>,
  minute: number,
  cx: number,
  cy: number,
  box: number,
  arm: number,
  sc: number,
): Vehicle[] {
  const armUnits = arm / sc; // arm length in unscaled canvas units (= 118)
  const vehicles: Vehicle[] = [];
  let globalId = 0;

  ids.slice(0, 4).forEach((id, i) => {
    const seriesData = series[id] ?? [];
    // Arms with all-zero queue_series are not rendered (T-intersection support)
    if (!seriesData.some(v => v > 0)) return;

    const rawQ = seriesData[minute] ?? 0;
    const count = Math.min(Math.round(rawQ), 15);
    let dist = 0; // distance from stop line in canvas units

    for (let k = 0; k < count; k++) {
      const type = TYPE_SEQUENCE[(i * 13 + k) % TYPE_SEQUENCE.length];
      const { length, width, speed, minGap } = VEHICLE_PARAMS[type];
      if (dist + length > armUnits * 0.92) break;

      let x: number, y: number, w: number, h: number;
      switch (i) {
        case 0: // N — queue from stop line going north (y decreases)
          x = cx - (width * sc) / 2;
          y = cy - box - (dist + length) * sc;
          w = width * sc;
          h = length * sc;
          break;
        case 1: // E — queue from stop line going east (x increases)
          x = cx + box + dist * sc;
          y = cy - (width * sc) / 2;
          w = length * sc;
          h = width * sc;
          break;
        case 2: // S — queue from stop line going south (y increases)
          x = cx - (width * sc) / 2;
          y = cy + box + dist * sc;
          w = width * sc;
          h = length * sc;
          break;
        case 3: // W — queue from stop line going west (x decreases)
          x = cx - box - (dist + length) * sc;
          y = cy - (width * sc) / 2;
          w = length * sc;
          h = width * sc;
          break;
        default:
          dist += length + minGap;
          return;
      }

      vehicles.push({ id: globalId++, type, approach: i, x, y, width: w, height: h, speed, gap: minGap });
      dist += length + minGap;
    }
  });

  return vehicles;
}

function paint(
  canvas: HTMLCanvasElement,
  chunk: SimulationChunk,
  timing: TimingChunk | null,
  mode: 'before' | 'after',
  simTime: number,
  ids: string[],
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const sc = Math.min(W / 460, H / 340);

  const box = 52 * sc;
  const arm = 118 * sc;
  const aw  = 42 * sc;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  const series = (mode === 'before' ? chunk.queue_series_before : chunk.queue_series_after) ?? {};
  const minute = Math.min(Math.floor(simTime / 60), 59);

  const showCycles = mode === 'after' && timing != null && !timing.signal_off;
  const gs = showCycles
    ? computeGreenState(ids, timing!.cycle_length, timing!.green_splits, simTime)
    : ids.map(() => false);

  // Roads (4 arms + center box)
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(cx - aw/2, cy - box - arm, aw, arm);  // N
  ctx.fillRect(cx - aw/2, cy + box,       aw, arm);  // S
  ctx.fillRect(cx + box,  cy - aw/2,      arm, aw);  // E
  ctx.fillRect(cx - box - arm, cy - aw/2, arm, aw);  // W
  ctx.fillRect(cx - box, cy - box, box*2, box*2);    // center

  // Lane edge lines
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy - box - arm, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy + box, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx + box, cy - aw/2, arm, aw);
  ctx.beginPath(); ctx.strokeRect(cx - box - arm, cy - aw/2, arm, aw);
  ctx.stroke();

  // Center lines (dashed yellow)
  ctx.setLineDash([6*sc, 7*sc]);
  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 1.5;
  const centerLines: [number, number, number, number][] = [
    [cx, cy - box,    cx, cy - box - arm],
    [cx, cy + box,    cx, cy + box + arm],
    [cx + box, cy,    cx + box + arm, cy],
    [cx - box, cy,    cx - box - arm, cy],
  ];
  for (const [x1, y1, x2, y2] of centerLines) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Stop lines
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2 * sc;
  const stopLines: [number, number, number, number][] = [
    [cx - aw/2, cy - box,  cx + aw/2, cy - box],
    [cx - aw/2, cy + box,  cx + aw/2, cy + box],
    [cx + box,  cy - aw/2, cx + box,  cy + aw/2],
    [cx - box,  cy - aw/2, cx - box,  cy + aw/2],
  ];
  for (const [x1, y1, x2, y2] of stopLines) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Vehicle entities — placed statically per queue count at the current minute
  const vehicles = placeVehicles(ids, series, minute, cx, cy, box, arm, sc);
  for (const v of vehicles) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = COLORS[v.approach % COLORS.length];
    ctx.fillRect(v.x, v.y, v.width, v.height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(v.x, v.y, v.width, v.height);

    const minDim = Math.min(v.width, v.height);
    if (minDim >= 8) {
      ctx.font = `bold ${Math.max(minDim * 0.5, 5)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.type, v.x + v.width / 2, v.y + v.height / 2);
    }
  }

  // Per-approach: signal dot + direction label
  ids.slice(0, 4).forEach((id, i) => {
    const isGreen = gs[i] ?? false;

    // Signal dot (near stop line, outer-right corner of arm)
    const r = 5 * sc;
    let sx = 0, sy = 0;
    switch (i) {
      case 0: sx = cx + aw/2 - r - 2*sc;  sy = cy - box - r - 3*sc;  break;
      case 1: sx = cx + box  + r + 3*sc;  sy = cy - aw/2 + r + 2*sc; break;
      case 2: sx = cx + aw/2 - r - 2*sc;  sy = cy + box  + r + 3*sc; break;
      case 3: sx = cx - box  - r - 3*sc;  sy = cy - aw/2 + r + 2*sc; break;
    }
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = showCycles ? (isGreen ? '#22c55e' : '#ef4444') : '#ca8a04';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Direction label
    let lx = 0, ly = 0;
    switch (i) {
      case 0: lx = cx;                     ly = cy - box - arm * 0.82; break;
      case 1: lx = cx + box + arm * 0.82;  ly = cy;                    break;
      case 2: lx = cx;                     ly = cy + box + arm * 0.82; break;
      case 3: lx = cx - box - arm * 0.82;  ly = cy;                    break;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${14 * sc}px sans-serif`;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(DIR_LABELS[i] ?? `A${i}`, lx, ly);
  });

  // HUD: sim clock + cycle phase
  const mm = String(Math.floor(simTime / 60)).padStart(2, '0');
  const ss = String(Math.floor(simTime % 60)).padStart(2, '0');
  ctx.font = `${11 * sc}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#475569';
  ctx.fillText(`${mm}:${ss} / 60:00`, 10 * sc, 10 * sc);
  if (timing) {
    const phase = Math.floor(simTime % timing.cycle_length);
    ctx.fillText(`cycle ${timing.cycle_length}s · phase ${phase}s`, 10 * sc, 24 * sc);
  }

  // Mode badge (top-right)
  ctx.textAlign = 'right';
  ctx.font = `bold ${11 * sc}px sans-serif`;
  ctx.fillStyle = mode === 'after' ? '#22c55e' : '#94a3b8';
  ctx.fillText(mode.toUpperCase(), W - 10 * sc, 10 * sc);
}

export function IntersectionCanvas({
  chunk,
  timing,
  signalStatus: _signalStatus,
}: {
  chunk: SimulationChunk;
  timing: TimingChunk | null;
  signalStatus: string;
}) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number>(0);
  const lastRtRef    = useRef<number>(0);

  const playingRef = useRef(false);
  const spsRef     = useRef(60);
  const modeRef    = useRef<'before' | 'after'>('after');
  const simTRef    = useRef(0);

  const chunkRef  = useRef(chunk);
  const timingRef = useRef(timing);
  const idsRef    = useRef<string[]>([]);

  chunkRef.current  = chunk;
  timingRef.current = timing;

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    return s ? Object.keys(s).sort() : [];
  }, [chunk]);

  idsRef.current = ids;

  const [playing, setPlaying] = useState(false);
  const [sps, setSps] = useState(60);
  const [mode, setMode] = useState<'before' | 'after'>('after');

  // Reset when chunk changes
  useEffect(() => {
    simTRef.current    = 0;
    playingRef.current = false;
    setPlaying(false);
  }, [chunk.chunk_name]);

  // Responsive canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const w = container.clientWidth;
      if (w > 0) {
        canvas.width  = w;
        canvas.height = Math.round(w * 0.65);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // RAF loop — permanent for component lifetime; reads all state from refs
  useEffect(() => {
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        if (playingRef.current) {
          const dt = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
          simTRef.current = Math.min(simTRef.current + dt * spsRef.current, SIM_DURATION);
          if (simTRef.current >= SIM_DURATION) {
            playingRef.current = false;
            setPlaying(false);
          }
        }
        lastRtRef.current = now;
        if (idsRef.current.length > 0) {
          paint(
            canvas,
            chunkRef.current,
            timingRef.current,
            modeRef.current,
            simTRef.current,
            idsRef.current,
          );
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastRtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePlay = () => {
    if (simTRef.current >= SIM_DURATION) simTRef.current = 0;
    lastRtRef.current = performance.now();
    playingRef.current = true;
    setPlaying(true);
  };
  const handlePause = () => { playingRef.current = false; setPlaying(false); };
  const handleReset = () => { simTRef.current = 0; playingRef.current = false; setPlaying(false); };
  const handleSpeed = (v: number) => { spsRef.current = v; setSps(v); };
  const handleMode  = (m: 'before' | 'after') => { modeRef.current = m; setMode(m); };

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="w-full rounded-md overflow-hidden">
        <canvas ref={canvasRef} className="w-full block" />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {playing ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handlePause}>
            <Pause className="size-3.5" /> Pause
          </Button>
        ) : (
          <Button size="sm" className="h-8 gap-1.5" onClick={handlePlay}>
            <Play className="size-3.5" /> Play
          </Button>
        )}
        <Button size="sm" variant="ghost" className="size-8 p-0" title="Reset" onClick={handleReset}>
          <RotateCcw className="size-3.5" />
        </Button>

        <div className="h-5 w-px bg-border mx-0.5" />

        {SPEEDS.map(sp => (
          <Button
            key={sp.label}
            size="sm"
            variant={sps === sp.sps ? 'default' : 'outline'}
            className="h-8 px-2.5 text-xs"
            onClick={() => handleSpeed(sp.sps)}
          >
            {sp.label}
          </Button>
        ))}

        <div className="h-5 w-px bg-border mx-0.5" />

        <Button
          size="sm"
          variant={mode === 'before' ? 'default' : 'outline'}
          className="h-8 text-xs"
          onClick={() => handleMode('before')}
        >
          Before
        </Button>
        <Button
          size="sm"
          variant={mode === 'after' ? 'default' : 'outline'}
          className="h-8 text-xs"
          onClick={() => handleMode('after')}
        >
          After
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Vehicle agents per approach · signal lights cycle per Webster's timing (After mode only)
      </p>
    </div>
  );
}
