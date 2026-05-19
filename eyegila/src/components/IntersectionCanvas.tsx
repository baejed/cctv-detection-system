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
const ARM_UNITS = 118;
const BOX_UNITS = 52;
const MAX_QUEUE = 15;
const MAX_PHYSICS_DT = 0.1;
const GAP_THRESHOLD_S = 6;
// Conflicting approach indices for gap-acceptance (perpendicular pairs)
const CONFLICTS: [number, number][][] = [[1, 3], [0, 2], [1, 3], [0, 2]];

type VehicleType = 'MC' | 'CAR' | 'JEP' | 'BUS' | 'TRUCK';

interface Vehicle {
  id: number;
  type: VehicleType;
  approach: number;
  distFromStop: number; // canvas units, front of vehicle to stop line (negative = past stop line)
  currSpeed: number;    // canvas units/s toward stop line
  clearing: boolean;    // true once front has crossed the stop line
}

const VEHICLE_PARAMS: Record<VehicleType, {
  length: number; width: number; maxSpeed: number; decel: number; minGap: number;
}> = {
  MC:    { length: 14, width: 8,  maxSpeed: 90, decel: 180, minGap: 8  },
  CAR:   { length: 18, width: 10, maxSpeed: 70, decel: 140, minGap: 12 },
  JEP:   { length: 22, width: 12, maxSpeed: 55, decel: 110, minGap: 16 },
  BUS:   { length: 28, width: 14, maxSpeed: 45, decel: 90,  minGap: 20 },
  TRUCK: { length: 28, width: 14, maxSpeed: 45, decel: 90,  minGap: 20 },
};

const TYPE_SEQUENCE: VehicleType[] = ['MC', 'CAR', 'MC', 'CAR', 'MC', 'JEP', 'MC', 'CAR', 'BUS', 'TRUCK'];

// --- Gap acceptance ---

function conflictingGapOk(approach: number, vehicles: Vehicle[]): boolean {
  const conflicts = CONFLICTS[approach] ?? [];
  for (const ca of conflicts) {
    // Only moving (non-stopped) queuing vehicles on the conflicting approach are threats
    const cvs = vehicles.filter(
      v => v.approach === ca && !v.clearing && v.distFromStop > 0 && v.currSpeed > 0,
    );
    if (cvs.length === 0) continue;
    cvs.sort((a, b) => a.distFromStop - b.distFromStop);
    const lead = cvs[0];
    if (lead.distFromStop / lead.currSpeed < GAP_THRESHOLD_S) return false;
  }
  return true;
}

// --- Physics ---

function stepPhysics(
  vehicles: Vehicle[],
  dt: number,
  greenFlags: boolean[],
  gapMode: boolean,
): void {
  // Remove vehicles that have fully exited the far end of the intersection
  const REMOVAL_DIST = -(BOX_UNITS + ARM_UNITS);
  for (let i = vehicles.length - 1; i >= 0; i--) {
    if (vehicles[i].distFromStop < REMOVAL_DIST) vehicles.splice(i, 1);
  }

  const byApproach = new Map<number, Vehicle[]>();
  for (const v of vehicles) {
    let list = byApproach.get(v.approach);
    if (!list) { list = []; byApproach.set(v.approach, list); }
    list.push(v);
  }

  for (const [ap, apVehicles] of byApproach) {
    // Clearing vehicles: accelerate to max speed through the box, no stop constraint
    for (const v of apVehicles.filter(v => v.clearing)) {
      const p = VEHICLE_PARAMS[v.type];
      v.currSpeed = Math.min(v.currSpeed + p.decel * 0.6 * dt, p.maxSpeed);
      v.distFromStop -= v.currSpeed * dt;
    }

    // Queuing vehicles: car-following + signal/gap logic
    const queuing = apVehicles.filter(v => !v.clearing).sort((a, b) => a.distFromStop - b.distFromStop);
    const canProceed = gapMode
      ? conflictingGapOk(ap, vehicles)
      : (greenFlags[ap] ?? false);

    for (let k = 0; k < queuing.length; k++) {
      const v = queuing[k];
      const p = VEHICLE_PARAMS[v.type];

      let obstaclePos: number;
      if (k === 0) {
        // Lead vehicle: stop line unless signal is green or gap accepted
        obstaclePos = canProceed ? -99999 : 0;
      } else {
        const ahead = queuing[k - 1];
        obstaclePos = ahead.distFromStop + VEHICLE_PARAMS[ahead.type].length + p.minGap;
      }

      const gap = v.distFromStop - obstaclePos;
      let targetSpeed: number;
      if (gap <= 0) {
        targetSpeed = 0;
      } else {
        const brakeDist = (p.maxSpeed * p.maxSpeed) / (2 * p.decel);
        targetSpeed = gap < brakeDist ? Math.sqrt(2 * p.decel * gap) : p.maxSpeed;
      }

      if (v.currSpeed > targetSpeed) {
        v.currSpeed = Math.max(v.currSpeed - p.decel * dt, targetSpeed);
      } else {
        v.currSpeed = Math.min(v.currSpeed + p.decel * 0.6 * dt, targetSpeed);
      }

      v.distFromStop = Math.max(v.distFromStop - v.currSpeed * dt, obstaclePos);

      // Transition to clearing once the front of the lead vehicle crosses the stop line
      if (k === 0 && canProceed && v.distFromStop < 0) {
        v.clearing = true;
      }
    }
  }
}

// --- Spawn ---

function spawnVehicles(
  vehicles: Vehicle[],
  timers: number[],
  counts: number[],
  nextId: { current: number },
  ids: string[],
  activeApproaches: Set<number>,
  intervals: number[],
  dtSim: number,
): void {
  for (let i = 0; i < ids.length && i < 4; i++) {
    if (!activeApproaches.has(i)) continue;
    timers[i] += dtSim;

    while (timers[i] >= intervals[i]) {
      timers[i] -= intervals[i];

      // Per-approach cap counts only queuing (non-clearing) vehicles
      const apVehicles = vehicles.filter(v => v.approach === i && !v.clearing);
      if (apVehicles.length >= MAX_QUEUE) continue;

      const type = TYPE_SEQUENCE[counts[i] % TYPE_SEQUENCE.length];
      const p = VEHICLE_PARAMS[type];
      const spawnDist = ARM_UNITS - p.length;

      if (apVehicles.length > 0) {
        const maxBack = Math.max(...apVehicles.map(v => v.distFromStop + VEHICLE_PARAMS[v.type].length));
        if (spawnDist - maxBack < p.minGap) continue;
      }

      vehicles.push({ id: nextId.current++, type, approach: i, distFromStop: spawnDist, currSpeed: 0, clearing: false });
      counts[i]++;
    }
  }
}

// --- Signal ---

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
    if (tInCycle >= elapsed && tInCycle < elapsed + g) { out[i] = true; break; }
    elapsed += g;
  }
  return out;
}

// --- Draw ---

function paint(
  canvas: HTMLCanvasElement,
  timing: TimingChunk | null,
  mode: 'before' | 'after',
  simTime: number,
  ids: string[],
  vehicles: Vehicle[],
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const sc = Math.min(W / 460, H / 340);

  const box = BOX_UNITS * sc;
  const arm = ARM_UNITS * sc;
  const aw  = 42 * sc;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  const showCycles = mode === 'after' && timing != null && !timing.signal_off;
  const gs = showCycles
    ? computeGreenState(ids, timing!.cycle_length, timing!.green_splits, simTime)
    : ids.map(() => false);

  // Roads
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(cx - aw/2, cy - box - arm, aw, arm);
  ctx.fillRect(cx - aw/2, cy + box,       aw, arm);
  ctx.fillRect(cx + box,  cy - aw/2,      arm, aw);
  ctx.fillRect(cx - box - arm, cy - aw/2, arm, aw);
  ctx.fillRect(cx - box, cy - box, box*2, box*2);

  // Lane edges
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy - box - arm, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx - aw/2, cy + box, aw, arm);
  ctx.beginPath(); ctx.strokeRect(cx + box, cy - aw/2, arm, aw);
  ctx.beginPath(); ctx.strokeRect(cx - box - arm, cy - aw/2, arm, aw);
  ctx.stroke();

  // Center lines
  ctx.setLineDash([6*sc, 7*sc]);
  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 1.5;
  for (const [x1, y1, x2, y2] of [
    [cx, cy - box,    cx, cy - box - arm],
    [cx, cy + box,    cx, cy + box + arm],
    [cx + box, cy,    cx + box + arm, cy],
    [cx - box, cy,    cx - box - arm, cy],
  ] as [number, number, number, number][]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Stop lines
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2 * sc;
  for (const [x1, y1, x2, y2] of [
    [cx - aw/2, cy - box,  cx + aw/2, cy - box],
    [cx - aw/2, cy + box,  cx + aw/2, cy + box],
    [cx + box,  cy - aw/2, cx + box,  cy + aw/2],
    [cx - box,  cy - aw/2, cx - box,  cy + aw/2],
  ] as [number, number, number, number][]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Vehicle entities (queuing + clearing)
  for (const v of vehicles) {
    const p = VEHICLE_PARAMS[v.type];
    const d = v.distFromStop;
    let x = 0, y = 0, w = 0, h = 0;
    switch (v.approach) {
      case 0: x = cx - (p.width*sc)/2; y = cy - box - (d + p.length)*sc; w = p.width*sc; h = p.length*sc; break;
      case 1: x = cx + box + d*sc;     y = cy - (p.width*sc)/2;          w = p.length*sc; h = p.width*sc; break;
      case 2: x = cx - (p.width*sc)/2; y = cy + box + d*sc;              w = p.width*sc; h = p.length*sc; break;
      case 3: x = cx - box - (d + p.length)*sc; y = cy - (p.width*sc)/2; w = p.length*sc; h = p.width*sc; break;
      default: continue;
    }
    ctx.globalAlpha = v.clearing ? 0.65 : 0.9;
    ctx.fillStyle = COLORS[v.approach % COLORS.length];
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x, y, w, h);
    const minDim = Math.min(w, h);
    if (minDim >= 8) {
      ctx.font = `bold ${Math.max(minDim * 0.5, 5)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.type, x + w / 2, y + h / 2);
    }
  }

  // Signal dots + direction labels
  ids.slice(0, 4).forEach((_id, i) => {
    const isGreen = gs[i] ?? false;
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

  // HUD
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
  ctx.fillText(`vehicles: ${vehicles.length}`, 10 * sc, 38 * sc);

  ctx.textAlign = 'right';
  ctx.font = `bold ${11 * sc}px sans-serif`;
  ctx.fillStyle = mode === 'after' ? '#22c55e' : '#94a3b8';
  ctx.fillText(mode.toUpperCase(), W - 10 * sc, 10 * sc);
}

// --- Component ---

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

  const timingRef = useRef(timing);
  const idsRef    = useRef<string[]>([]);

  timingRef.current = timing;

  // Physics state
  const vehiclesRef          = useRef<Vehicle[]>([]);
  const spawnTimersRef       = useRef<number[]>([0, 0, 0, 0]);
  const spawnCountsRef       = useRef<number[]>([0, 0, 0, 0]);
  const nextVehicleIdRef     = useRef(0);
  const spawnIntervalsRef    = useRef<number[]>([Infinity, Infinity, Infinity, Infinity]);
  const activeApproachesRef  = useRef<Set<number>>(new Set());

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    return s ? Object.keys(s).sort() : [];
  }, [chunk]);

  idsRef.current = ids;

  const [playing, setPlaying] = useState(false);
  const [sps, setSps] = useState(60);
  const [mode, setMode] = useState<'before' | 'after'>('after');

  // Recompute spawn intervals when chunk/ids change
  useEffect(() => {
    const series = (chunk.queue_series_after ?? chunk.queue_series_before) ?? {};
    const active = new Set<number>();
    ids.forEach((id, i) => {
      if (i < 4) {
        const s = series[id] ?? [];
        if (s.some(v => v > 0)) active.add(i);
      }
    });
    activeApproachesRef.current = active;
    const numActive = Math.max(active.size, 1);
    const perApproachVolume = chunk.volume_pcu_hr / numActive;
    const interval = 3600 / Math.max(perApproachVolume, 0.1);
    spawnIntervalsRef.current = [interval, interval, interval, interval];
  }, [chunk, ids]);

  // Reset vehicle state and sim clock when chunk changes
  useEffect(() => {
    vehiclesRef.current       = [];
    spawnTimersRef.current    = [0, 0, 0, 0];
    spawnCountsRef.current    = [0, 0, 0, 0];
    nextVehicleIdRef.current  = 0;
    simTRef.current           = 0;
    playingRef.current        = false;
    setPlaying(false);
  }, [chunk.chunk_name]);

  // Responsive canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const w = container.clientWidth;
      if (w > 0) { canvas.width = w; canvas.height = Math.round(w * 0.65); }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // RAF loop — permanent; all state from refs
  useEffect(() => {
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        if (playingRef.current) {
          const dt = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
          const dtSim = Math.min(dt * spsRef.current, 1.0);

          // Sub-step: spawn + physics; compute signal state per sub-step for accuracy
          let remaining = dtSim;
          let subT = simTRef.current;
          while (remaining > 0) {
            const step = Math.min(remaining, MAX_PHYSICS_DT);
            const t = timingRef.current;
            const useGapMode = modeRef.current === 'before' || !t || t.signal_off;
            const greenFlags = (!useGapMode && t)
              ? computeGreenState(idsRef.current, t.cycle_length, t.green_splits, subT)
              : new Array(idsRef.current.length).fill(false);

            spawnVehicles(
              vehiclesRef.current,
              spawnTimersRef.current,
              spawnCountsRef.current,
              nextVehicleIdRef,
              idsRef.current,
              activeApproachesRef.current,
              spawnIntervalsRef.current,
              step,
            );
            stepPhysics(vehiclesRef.current, step, greenFlags, useGapMode);

            subT += step;
            remaining -= step;
          }

          simTRef.current = Math.min(simTRef.current + dtSim, SIM_DURATION);
          if (simTRef.current >= SIM_DURATION) {
            playingRef.current = false;
            setPlaying(false);
          }
        }
        lastRtRef.current = now;
        if (idsRef.current.length > 0) {
          paint(
            canvas,
            timingRef.current,
            modeRef.current,
            simTRef.current,
            idsRef.current,
            vehiclesRef.current,
          );
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastRtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetState = () => {
    vehiclesRef.current      = [];
    spawnTimersRef.current   = [0, 0, 0, 0];
    spawnCountsRef.current   = [0, 0, 0, 0];
    nextVehicleIdRef.current = 0;
    simTRef.current          = 0;
    playingRef.current       = false;
    setPlaying(false);
  };

  const handlePlay  = () => {
    if (simTRef.current >= SIM_DURATION) resetState();
    lastRtRef.current  = performance.now();
    playingRef.current = true;
    setPlaying(true);
  };
  const handlePause = () => { playingRef.current = false; setPlaying(false); };
  const handleReset = resetState;
  const handleSpeed = (v: number) => { spsRef.current = v; setSps(v); };
  const handleMode  = (m: 'before' | 'after') => { modeRef.current = m; setMode(m); };

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="w-full rounded-md overflow-hidden">
        <canvas ref={canvasRef} className="w-full block" />
      </div>

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
        After: Webster signal cycles · Before / signal-off: gap-acceptance (6 s) · toggle live
      </p>
    </div>
  );
}
