import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { SimulationChunk } from '@/services/simulation';
import type { TimingChunk } from '@/services/timing';

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444'];
const DIR_LABELS = ['N', 'E', 'S', 'W'];
const SPEEDS = [
  { label: '⅒×', sps: 6 },
  { label: '¼×', sps: 15 },
  { label: '1×',  sps: 60 },
  { label: '5×',  sps: 300 },
  { label: '10×', sps: 600 },
];
const SIM_DURATION = 3600;
const ARM_UNITS = 118;
const BOX_UNITS = 52;
const MAX_QUEUE = 15;
const MAX_PHYSICS_DT = 0.1;
const GAP_THRESHOLD_S = 6;
const GAP_PHASE_S = 10; // each axis (N-S or E-W) gets this many sim-seconds of priority
// Conflicting approach indices for gap-acceptance (perpendicular pairs)
const CONFLICTS: number[][] = [[1, 3], [0, 2], [1, 3], [0, 2]];

// Turn routing geometry (canvas units from intersection center)
const ARM_ENTRY: [number, number][] = [
  [0, -BOX_UNITS], [BOX_UNITS, 0], [0, BOX_UNITS], [-BOX_UNITS, 0],
];
const ARM_EXIT_PT: [number, number][] = [
  [0, -(BOX_UNITS + ARM_UNITS)], [BOX_UNITS + ARM_UNITS, 0],
  [0, BOX_UNITS + ARM_UNITS],    [-(BOX_UNITS + ARM_UNITS), 0],
];
// Exit arm index per approach: [through, left, right]
const TURN_EXIT: [number, number, number][] = [
  [2, 1, 3], [3, 2, 0], [0, 3, 1], [1, 0, 2],
];

export type VehicleType = 'MC' | 'CAR' | 'JEP' | 'BUS' | 'TRUCK';
export type TypeFractions = Record<VehicleType, number>;

const DEFAULT_TYPE_MIX: TypeFractions = {
  MC: 0.50, CAR: 0.30, JEP: 0.15, BUS: 0.03, TRUCK: 0.02,
};

const VEHICLE_TYPES: VehicleType[] = ['MC', 'CAR', 'JEP', 'BUS', 'TRUCK'];

function sampleType(fractions: TypeFractions): VehicleType {
  const r = Math.random();
  let cum = 0;
  for (const t of VEHICLE_TYPES) {
    cum += fractions[t];
    if (r < cum) return t;
  }
  return 'CAR';
}

interface Vehicle {
  id: number;
  type: VehicleType;
  approach: number;
  distFromStop: number;
  currSpeed: number;
  clearing: boolean;
  turn: 'through' | 'left' | 'right' | null;
  px: number;   // canvas units from center; valid when clearing
  py: number;
  waypoints: { x: number; y: number }[];
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

// --- Turn routing ---

function buildWaypoints(approach: number, turn: 'through' | 'left' | 'right'): { x: number; y: number }[] {
  const exitArm = TURN_EXIT[approach][turn === 'through' ? 0 : turn === 'left' ? 1 : 2];
  const [sx, sy] = ARM_ENTRY[exitArm];
  const [ex, ey] = ARM_EXIT_PT[exitArm];
  if (turn === 'through') {
    return [{ x: sx, y: sy }, { x: ex, y: ey }];
  }
  return [{ x: 0, y: 0 }, { x: sx, y: sy }, { x: ex, y: ey }];
}

function initClearing(v: Vehicle): void {
  const r = (v.id * 1337 + 42) % 100;
  v.turn = r < 70 ? 'through' : r < 85 ? 'left' : 'right';
  [v.px, v.py] = ARM_ENTRY[v.approach];
  v.waypoints = buildWaypoints(v.approach, v.turn);
}

// --- Gap acceptance ---

// Alternates priority between N-S (approaches 0&2) and E-W (approaches 1&3) every
// GAP_PHASE_S sim-seconds.  Without this, all four approaches stop, nobody blocks
// anyone (speed=0), and all discharge simultaneously through the box.
function conflictingGapOk(approach: number, vehicles: Vehicle[], gapTime: number): boolean {
  // axis 0 = N-S (approach % 2 === 0); axis 1 = E-W (approach % 2 === 1)
  const axisNow = Math.floor(gapTime / GAP_PHASE_S) % 2;
  if (approach % 2 !== axisNow) return false;

  const conflicts = CONFLICTS[approach] ?? [];
  for (const ca of conflicts) {
    const cvs = vehicles.filter(v => v.approach === ca && !v.clearing);
    if (cvs.length === 0) continue;
    cvs.sort((a, b) => a.distFromStop - b.distFromStop);
    const lead = cvs[0];
    const leadLen = VEHICLE_PARAMS[lead.type].length;
    // Lead is physically at/past the stop line — conflict zone occupied
    if (lead.distFromStop < leadLen) return false;
    // Lead approaching within threshold
    if (lead.currSpeed > 0 && lead.distFromStop / lead.currSpeed < GAP_THRESHOLD_S) return false;
  }
  return true;
}

// --- Physics ---

function stepPhysics(
  vehicles: Vehicle[],
  dt: number,
  greenFlags: boolean[],
  gapMode: boolean,
  gapTime = 0,
): void {
  // Move clearing vehicles along their waypoint path
  for (const v of vehicles) {
    if (!v.clearing) continue;
    const p = VEHICLE_PARAMS[v.type];
    v.currSpeed = Math.min(v.currSpeed + p.decel * 0.6 * dt, p.maxSpeed);
    let rem = v.currSpeed * dt;
    while (rem > 1e-9 && v.waypoints.length > 0) {
      const wp = v.waypoints[0];
      const dx = wp.x - v.px;
      const dy = wp.y - v.py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) { v.waypoints.shift(); continue; }
      if (rem >= d) {
        v.px = wp.x; v.py = wp.y;
        v.waypoints.shift();
        rem -= d;
      } else {
        v.px += (dx / d) * rem;
        v.py += (dy / d) * rem;
        rem = 0;
      }
    }
  }

  // Remove clearing vehicles that have reached their exit
  for (let i = vehicles.length - 1; i >= 0; i--) {
    if (vehicles[i].clearing && vehicles[i].waypoints.length === 0) vehicles.splice(i, 1);
  }

  // Car-following for queuing vehicles
  const byApproach = new Map<number, Vehicle[]>();
  for (const v of vehicles) {
    if (v.clearing) continue;
    let list = byApproach.get(v.approach);
    if (!list) { list = []; byApproach.set(v.approach, list); }
    list.push(v);
  }

  for (const [ap, apVehicles] of byApproach) {
    const queuing = apVehicles.sort((a, b) => a.distFromStop - b.distFromStop);
    const canProceed = gapMode
      ? conflictingGapOk(ap, vehicles, gapTime)
      : (greenFlags[ap] ?? false);

    for (let k = 0; k < queuing.length; k++) {
      const v = queuing[k];
      const p = VEHICLE_PARAMS[v.type];

      let obstaclePos: number;
      if (k === 0) {
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

      if (k === 0 && canProceed && v.distFromStop < 0) {
        v.clearing = true;
        initClearing(v);
      }
    }
  }
}

// --- Spawn ---

function spawnVehicles(
  vehicles: Vehicle[],
  timers: number[],
  nextId: { current: number },
  ids: string[],
  activeApproaches: Set<number>,
  intervals: number[],
  typeMixByApproach: TypeFractions[],
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

      const type = sampleType(typeMixByApproach[i] ?? DEFAULT_TYPE_MIX);
      const p = VEHICLE_PARAMS[type];
      const spawnDist = ARM_UNITS - p.length;

      if (apVehicles.length > 0) {
        const maxBack = Math.max(...apVehicles.map(v => v.distFromStop + VEHICLE_PARAMS[v.type].length));
        if (spawnDist - maxBack < p.minGap) continue;
      }

      vehicles.push({
        id: nextId.current++, type, approach: i,
        distFromStop: spawnDist, currSpeed: 0, clearing: false,
        turn: null, px: 0, py: 0, waypoints: [],
      });
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
  if (n === 0) return [];
  // Normalise splits so they sum exactly to cycleLength — prevents float gaps
  // where tInCycle falls between phases and no approach gets green.
  const raw = ids.map(id => Math.max(splits[id] ?? cycleLength / n, 0));
  const total = raw.reduce((a, b) => a + b, 0) || cycleLength;
  const norm = raw.map(g => (g / total) * cycleLength);

  const tInCycle = simTime % cycleLength;
  const out = new Array<boolean>(n).fill(false);
  let elapsed = 0;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? cycleLength : elapsed + norm[i];
    if (tInCycle >= elapsed && tInCycle < end) { out[i] = true; return out; }
    elapsed += norm[i];
  }
  // Fallback: last phase catches floating-point edge at tInCycle ≈ cycleLength
  out[n - 1] = true;
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

  // Queuing vehicles (approach-aligned rects)
  for (const v of vehicles) {
    if (v.clearing) continue;
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
    ctx.globalAlpha = 0.9;
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

  // Clearing (in-transit) vehicles — oriented toward next waypoint
  const AP_ANGLE = [Math.PI / 2, Math.PI, -Math.PI / 2, 0];
  for (const v of vehicles) {
    if (!v.clearing || v.waypoints.length === 0) continue;
    const p = VEHICLE_PARAMS[v.type];
    const wx = cx + v.px * sc;
    const wy = cy + v.py * sc;
    const wp = v.waypoints[0];
    const hdx = wp.x - v.px;
    const hdy = wp.y - v.py;
    const hlen = Math.sqrt(hdx * hdx + hdy * hdy);
    const angle = hlen > 1e-6 ? Math.atan2(hdy, hdx) : (AP_ANGLE[v.approach] ?? 0);
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = COLORS[v.approach % COLORS.length];
    ctx.fillRect(-p.length * sc / 2, -p.width * sc / 2, p.length * sc, p.width * sc);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-p.length * sc / 2, -p.width * sc / 2, p.length * sc, p.width * sc);
    const minDim = Math.min(p.length, p.width) * sc;
    if (minDim >= 8) {
      ctx.font = `bold ${Math.max(minDim * 0.5, 5)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.type, 0, 0);
    }
    ctx.restore();
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
    const greenIdx = gs.indexOf(true);
    const greenLabel = greenIdx >= 0 ? `  green: ${DIR_LABELS[greenIdx] ?? `A${greenIdx}`}` : '';
    ctx.fillText(`cycle ${timing.cycle_length}s · ${phase}s${greenLabel}`, 10 * sc, 24 * sc);
  }

  // Per-approach queue depth
  const qCounts = ids.slice(0, 4).map((_, i) =>
    vehicles.filter(v => v.approach === i && !v.clearing).length,
  );
  const qLabel = ids.slice(0, 4).map((_, i) =>
    `${DIR_LABELS[i] ?? `A${i}`}:${qCounts[i]}`,
  ).join('  ');
  ctx.fillText(qLabel, 10 * sc, 38 * sc);

  ctx.textAlign = 'right';
  ctx.font = `bold ${11 * sc}px sans-serif`;
  ctx.fillStyle = mode === 'after' ? '#22c55e' : '#94a3b8';
  ctx.fillText(mode.toUpperCase(), W - 10 * sc, 10 * sc);

  // Total vehicle count bottom-right
  ctx.font = `${11 * sc}px monospace`;
  ctx.fillStyle = '#475569';
  ctx.fillText(`${vehicles.length} vehicles`, W - 10 * sc, 24 * sc);
}

// --- Component ---

export function IntersectionCanvas({
  chunk,
  timing,
  signalStatus: _signalStatus,
  typeMix = {},
}: {
  chunk: SimulationChunk;
  timing: TimingChunk | null;
  signalStatus: string;
  typeMix?: Record<string, TypeFractions>;
}) {
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number>(0);
  const lastRtRef    = useRef<number>(0);

  const playingRef = useRef(false);
  const spsRef     = useRef(6);
  const modeRef    = useRef<'before' | 'after'>('after');
  const simTRef    = useRef(0);

  const timingRef  = useRef(timing);
  const idsRef     = useRef<string[]>([]);
  const typeMixRef = useRef<Record<string, TypeFractions>>(typeMix);

  timingRef.current  = timing;
  typeMixRef.current = typeMix;

  // Physics state
  const vehiclesRef          = useRef<Vehicle[]>([]);
  const spawnTimersRef       = useRef<number[]>([0, 0, 0, 0]);
  const nextVehicleIdRef     = useRef(0);
  const spawnIntervalsRef    = useRef<number[]>([Infinity, Infinity, Infinity, Infinity]);
  const activeApproachesRef  = useRef<Set<number>>(new Set());

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    return s ? Object.keys(s).sort() : [];
  }, [chunk]);

  idsRef.current = ids;

  const [playing, setPlaying] = useState(false);
  const [sps, setSps] = useState(6);
  const [mode, setMode] = useState<'before' | 'after'>('after');
  const [isFullscreen, setIsFullscreen] = useState(false);

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
    // Cap at 30 sim-s so low-volume intersections still show visible traffic.
    const interval = Math.min(3600 / Math.max(perApproachVolume, 0.1), 30);
    spawnIntervalsRef.current = [interval, interval, interval, interval];
  }, [chunk, ids]);

  // Reset vehicle state and sim clock when chunk changes
  useEffect(() => {
    vehiclesRef.current       = [];
    spawnTimersRef.current    = [0, 0, 0, 0];
    nextVehicleIdRef.current  = 0;
    simTRef.current           = 0;
    playingRef.current        = false;
    setPlaying(false);
  }, [chunk.chunk_name]);

  // Responsive canvas sizing — multiply by devicePixelRatio for sharp rendering
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const dpr  = window.devicePixelRatio || 1;
      const full = !!document.fullscreenElement;
      const w    = full ? container.clientWidth  : Math.min(container.clientWidth, 420);
      const h    = full ? container.clientHeight : Math.round(w * 0.58);
      if (w > 0 && h > 0) {
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Sync fullscreen state and trigger a resize when entering/exiting
  useEffect(() => {
    const onFsChange = () => {
      const full = !!document.fullscreenElement;
      setIsFullscreen(full);
      // ResizeObserver fires automatically when the container resizes, but
      // trigger an explicit recalc for the devicePixelRatio path.
      const container = containerRef.current;
      const canvas    = canvasRef.current;
      if (!container || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w   = full ? container.clientWidth  : Math.min(container.clientWidth, 420);
      const h   = full ? container.clientHeight : Math.round(w * 0.58);
      if (w > 0 && h > 0) {
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // RAF loop — permanent; all state from refs
  useEffect(() => {
    const loop = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        if (playingRef.current) {
          const dt = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
          const dtSim = Math.min(dt * spsRef.current, 1.0);

          let remaining = dtSim;
          let subT = simTRef.current;
          while (remaining > 0) {
            const step = Math.min(remaining, MAX_PHYSICS_DT);
            const t = timingRef.current;
            const useGapMode = modeRef.current === 'before' || !t || t.signal_off;
            const greenFlags = (!useGapMode && t)
              ? computeGreenState(idsRef.current, t.cycle_length, t.green_splits, subT)
              : new Array(idsRef.current.length).fill(false);

            const mixPerApproach = idsRef.current.map(
              sid => typeMixRef.current[sid] ?? DEFAULT_TYPE_MIX,
            );
            spawnVehicles(
              vehiclesRef.current,
              spawnTimersRef.current,
              nextVehicleIdRef,
              idsRef.current,
              activeApproachesRef.current,
              spawnIntervalsRef.current,
              mixPerApproach,
              step,
            );
            stepPhysics(vehiclesRef.current, step, greenFlags, useGapMode, subT);

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
  const handlePause      = () => { playingRef.current = false; setPlaying(false); };
  const handleReset      = resetState;
  const handleSpeed      = (v: number) => { spsRef.current = v; setSps(v); };
  const handleMode       = (m: 'before' | 'after') => { modeRef.current = m; setMode(m); };
  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      wrapperRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'space-y-3',
        isFullscreen && 'bg-[#0f172a] flex flex-col p-4 h-full',
      )}
    >
      <div
        ref={containerRef}
        className={cn('rounded-md overflow-hidden', isFullscreen ? 'flex-1 w-full' : 'w-full')}
      >
        <canvas ref={canvasRef} className="block" />
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

        <div className="h-5 w-px bg-border mx-0.5" />

        <Button
          size="sm"
          variant="ghost"
          className="size-8 p-0"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={handleFullscreen}
        >
          {isFullscreen
            ? <Minimize2 className="size-3.5" />
            : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      {!isFullscreen && (
        <p className="text-xs text-muted-foreground">
          After: Webster signal cycles · Before / signal-off: gap-acceptance (6 s) · toggle live
        </p>
      )}
    </div>
  );
}

// --- Dual simulation ---

const PESO_PER_VEH_HR = 65; // conservative value-of-time estimate (₱/veh-hr) for PH secondary city

function createSimState() {
  return {
    vehicles: [] as Vehicle[],
    timers:   [0, 0, 0, 0] as number[],
    nextId:   { current: 0 },
  };
}

function applyCanvasSize(container: HTMLDivElement, canvas: HTMLCanvasElement, fullscreen: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w   = fullscreen ? container.clientWidth : container.clientWidth;
  const h   = Math.round(w * 0.72);
  if (w > 0 && h > 0) {
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

export function DualIntersectionCanvas({
  chunk,
  timing,
  signalStatus: _signalStatus,
  typeMix = {},
  paused = false,
  speed = 1,
}: {
  chunk: SimulationChunk;
  timing: TimingChunk | null;
  signalStatus: string;
  typeMix?: Record<string, TypeFractions>;
  paused?: boolean;
  speed?: 1 | 2 | 4;
}) {
  const wrapperRef        = useRef<HTMLDivElement>(null);
  const canvasBeforeRef   = useRef<HTMLCanvasElement>(null);
  const ctnBeforeRef      = useRef<HTMLDivElement>(null);
  const canvasAfterRef    = useRef<HTMLCanvasElement>(null);
  const ctnAfterRef       = useRef<HTMLDivElement>(null);

  const beforeSim = useRef(createSimState());
  const afterSim  = useRef(createSimState());

  const rafRef     = useRef<number>(0);
  const lastRtRef  = useRef<number>(0);
  const playingRef = useRef(false);
  const spsRef     = useRef(6);
  const simTRef    = useRef(0);
  const frameRef   = useRef(0);

  const timingRef  = useRef(timing);
  const idsRef     = useRef<string[]>([]);
  const typeMixRef = useRef<Record<string, TypeFractions>>(typeMix);
  timingRef.current  = timing;
  typeMixRef.current = typeMix;

  const spawnIntervalsRef   = useRef<number[]>([Infinity, Infinity, Infinity, Infinity]);
  const activeApproachesRef = useRef<Set<number>>(new Set());

  const ids = useMemo(() => {
    const s = chunk.queue_series_after ?? chunk.queue_series_before;
    return s ? Object.keys(s).sort() : [];
  }, [chunk]);
  idsRef.current = ids;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [liveQ, setLiveQ]             = useState({ before: 0, after: 0 });

  // Sync external paused / speed props into refs used by the RAF loop
  useEffect(() => { playingRef.current = !paused; }, [paused]);
  useEffect(() => { spsRef.current = 60 * speed; }, [speed]);

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
    const perVol    = chunk.volume_pcu_hr / numActive;
    spawnIntervalsRef.current = Array(4).fill(Math.min(3600 / Math.max(perVol, 0.1), 30));
  }, [chunk, ids]);

  useEffect(() => {
    beforeSim.current  = createSimState();
    afterSim.current   = createSimState();
    simTRef.current    = 0;
    playingRef.current = !paused;
    setLiveQ({ before: 0, after: 0 });
  }, [chunk.chunk_name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Canvas sizing — observe both containers
  useEffect(() => {
    const pairs: [React.RefObject<HTMLDivElement | null>, React.RefObject<HTMLCanvasElement | null>][] = [
      [ctnBeforeRef, canvasBeforeRef],
      [ctnAfterRef,  canvasAfterRef],
    ];
    const observers: ResizeObserver[] = [];
    for (const [cRef, cvRef] of pairs) {
      const container = cRef.current;
      const canvas    = cvRef.current;
      if (!container || !canvas) continue;
      const resize = () => applyCanvasSize(container, canvas, !!document.fullscreenElement);
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      observers.push(ro);
    }
    return () => observers.forEach(ro => ro.disconnect());
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      const full = !!document.fullscreenElement;
      setIsFullscreen(full);
      const pairs: [React.RefObject<HTMLDivElement | null>, React.RefObject<HTMLCanvasElement | null>][] = [
        [ctnBeforeRef, canvasBeforeRef],
        [ctnAfterRef,  canvasAfterRef],
      ];
      for (const [cRef, cvRef] of pairs) {
        const container = cRef.current;
        const canvas    = cvRef.current;
        if (container && canvas) applyCanvasSize(container, canvas, full);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const loop = (now: number) => {
      const cvB = canvasBeforeRef.current;
      const cvA = canvasAfterRef.current;
      if (cvB && cvA && cvB.width > 0 && cvA.width > 0) {
        if (playingRef.current) {
          const dt    = lastRtRef.current > 0 ? (now - lastRtRef.current) / 1000 : 0;
          const dtSim = Math.min(dt * spsRef.current, 1.0);
          let remaining = dtSim;
          let subT      = simTRef.current;
          while (remaining > 0) {
            const step    = Math.min(remaining, MAX_PHYSICS_DT);
            const t       = timingRef.current;
            const gapAfter = !t || t.signal_off;
            const greenA  = !gapAfter
              ? computeGreenState(idsRef.current, t!.cycle_length, t!.green_splits, subT)
              : new Array(idsRef.current.length).fill(false);
            const greenB  = new Array(idsRef.current.length).fill(false);
            const mix     = idsRef.current.map(sid => typeMixRef.current[sid] ?? DEFAULT_TYPE_MIX);

            spawnVehicles(beforeSim.current.vehicles, beforeSim.current.timers,
              beforeSim.current.nextId, idsRef.current,
              activeApproachesRef.current, spawnIntervalsRef.current, mix, step);
            spawnVehicles(afterSim.current.vehicles, afterSim.current.timers,
              afterSim.current.nextId, idsRef.current,
              activeApproachesRef.current, spawnIntervalsRef.current, mix, step);

            stepPhysics(beforeSim.current.vehicles, step, greenB, true,     subT);
            stepPhysics(afterSim.current.vehicles,  step, greenA, gapAfter, subT);

            subT      += step;
            remaining -= step;
          }
          simTRef.current = Math.min(simTRef.current + dtSim, SIM_DURATION);
          if (simTRef.current >= SIM_DURATION) { playingRef.current = false; }
        }
        lastRtRef.current = now;
        if (idsRef.current.length > 0) {
          paint(cvB, timingRef.current, 'before', simTRef.current, idsRef.current, beforeSim.current.vehicles);
          paint(cvA, timingRef.current, 'after',  simTRef.current, idsRef.current, afterSim.current.vehicles);
          frameRef.current++;
          if (frameRef.current % 30 === 0) {
            setLiveQ({
              before: beforeSim.current.vehicles.filter(v => !v.clearing).length,
              after:  afterSim.current.vehicles.filter(v  => !v.clearing).length,
            });
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    lastRtRef.current = performance.now();
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetState = () => {
    beforeSim.current  = createSimState();
    afterSim.current   = createSimState();
    simTRef.current    = 0;
    playingRef.current = !paused;
    setLiveQ({ before: 0, after: 0 });
  };

  const handleFullscreen = () => {
    if (!document.fullscreenElement) wrapperRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };

  const delayDiff = chunk.delay_before - chunk.delay_after;
  const pesoSaved = chunk.vehicle_hours_saved * PESO_PER_VEH_HR;
  const qDiff     = liveQ.before - liveQ.after;

  return (
    <div
      ref={wrapperRef}
      className={cn('space-y-3', isFullscreen && 'bg-[#0f172a] flex flex-col p-4 h-full')}
    >
      {/* Side-by-side canvases */}
      <div className={cn('grid grid-cols-2 gap-2', isFullscreen && 'flex-1')}>
        <div className={cn('flex flex-col', isFullscreen && 'flex-1')}>
          <p className="text-[10px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">
            Before — gap acceptance
          </p>
          <div ref={ctnBeforeRef} className="rounded-md overflow-hidden w-full">
            <canvas ref={canvasBeforeRef} className="block" />
          </div>
        </div>
        <div className={cn('flex flex-col', isFullscreen && 'flex-1')}>
          <p className="text-[10px] font-medium text-green-500 mb-1 uppercase tracking-wide">
            After — Webster's signal
          </p>
          <div ref={ctnAfterRef} className="rounded-md overflow-hidden w-full">
            <canvas ref={canvasAfterRef} className="block" />
          </div>
        </div>
      </div>

      {/* Live queue comparison */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Queuing</p>
          <p className="text-2xl font-semibold tabular-nums mt-0.5">{liveQ.before}</p>
        </div>
        <div className="rounded-md border border-green-500/30 bg-card px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Queuing</p>
          <div className="flex items-end gap-1.5 mt-0.5">
            <span className="text-2xl font-semibold tabular-nums text-green-500">{liveQ.after}</span>
            {qDiff > 0 && (
              <span className="text-green-500 text-xs font-medium mb-0.5">−{qDiff} fewer</span>
            )}
          </div>
        </div>
      </div>

      {/* Savings strip */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-border bg-card px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Delay saved</p>
          <p className="text-xl font-semibold tabular-nums mt-0.5">
            {delayDiff > 0 ? `−${delayDiff.toFixed(0)}s` : '—'}
          </p>
          <p className="text-[10px] text-muted-foreground">per vehicle</p>
        </div>
        <div className="rounded-md border border-border bg-card px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Veh-hrs saved</p>
          <p className="text-xl font-semibold tabular-nums mt-0.5">{chunk.vehicle_hours_saved.toFixed(2)}</p>
          <p className="text-[10px] text-muted-foreground">this chunk</p>
        </div>
        <div className="rounded-md border border-green-500/30 bg-card px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Est. savings</p>
          <p className="text-xl font-semibold tabular-nums mt-0.5 text-green-500">
            {pesoSaved > 0 ? `₱${Math.round(pesoSaved)}` : '—'}
          </p>
          <p className="text-[10px] text-muted-foreground">chunk · @₱{PESO_PER_VEH_HR}/veh-hr</p>
        </div>
      </div>

      {/* Controls: reset + fullscreen only — play/pause and speed are in the parent strip */}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="size-8 p-0" title="Reset simulation" onClick={resetState}>
          <RotateCcw className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="size-8 p-0"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={handleFullscreen}
        >
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
