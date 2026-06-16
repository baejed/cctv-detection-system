import { useEffect, useRef, useState } from 'react';
import type { TimingChunk } from '@/services/timing';
import type { Street } from '@/types';

// ── Constants ────────────────────────────────────────────────────────────────

const AMBER_S   = 3;   // amber duration before red
const ALL_RED_S = 3;   // all-red clearance between phases

const OPPOSING: Record<string, string> = {
  northbound: 'southbound', southbound: 'northbound',
  eastbound:  'westbound',  westbound:  'eastbound',
};

const DIR_SHORT: Record<string, string> = {
  northbound: 'NB', southbound: 'SB',
  eastbound:  'EB', westbound:  'WB',
  unknown:    '?',
};

type LightPhase = 'green' | 'amber' | 'red' | 'off';

// ── Phase logic (mirrors backend group_phases) ────────────────────────────────

function buildPhases(streetIds: number[], dirMap: Record<number, string>): number[][] {
  const byDir: Record<string, number[]> = {};
  const unknowns: number[] = [];
  for (const sid of streetIds) {
    const d = dirMap[sid] ?? 'unknown';
    if (d === 'unknown') {
      unknowns.push(sid);
    } else {
      (byDir[d] ??= []).push(sid);
    }
  }
  const seen = new Set<string>();
  const phases: number[][] = [];
  for (const [dir, sids] of Object.entries(byDir)) {
    if (seen.has(dir)) continue;
    const opp = OPPOSING[dir];
    if (opp && byDir[opp]) {
      phases.push([...sids, ...byDir[opp]]);
      seen.add(dir); seen.add(opp);
    } else {
      phases.push(sids);
      seen.add(dir);
    }
  }
  // Unknown-direction streets each get their own phase (round-robin fallback)
  for (const sid of unknowns) phases.push([sid]);
  return phases.length ? phases : streetIds.map(s => [s]);
}

function phaseAt(
  t: number,
  phases: number[][],
  splits: Record<string, number>,
  sid: number,
  signalOff: boolean,
): LightPhase {
  if (signalOff) return 'off';

  const phaseMaxG = phases.map(ph =>
    Math.max(...ph.map(s => splits[String(s)] ?? 0), 0),
  );
  const cycle = phaseMaxG.reduce((a, g) => a + g + ALL_RED_S, 0);
  if (cycle <= 0) return 'red';

  const tMod = t % cycle;
  let cursor = 0;

  for (let i = 0; i < phases.length; i++) {
    const g = phaseMaxG[i];
    if (tMod < cursor + g) {
      if (!phases[i].includes(sid)) return 'red';
      return (cursor + g) - tMod <= AMBER_S ? 'amber' : 'green';
    }
    cursor += g;
    if (tMod < cursor + ALL_RED_S) return 'red';
    cursor += ALL_RED_S;
  }

  return 'red';
}

// ── Visual primitives ────────────────────────────────────────────────────────

function Lens({ on, color, glow }: { on: boolean; color: string; glow: string }) {
  return (
    <div style={{
      width: 22, height: 22,
      borderRadius: '50%',
      background: on ? color : '#141e2e',
      boxShadow: on
        ? `0 0 16px 7px ${glow}, 0 0 5px 2px ${color}, inset 0 2px 4px rgba(255,255,255,0.25)`
        : 'inset 0 2px 3px rgba(0,0,0,0.6)',
      border: '1.5px solid rgba(255,255,255,0.07)',
      transition: 'background 0.12s ease, box-shadow 0.12s ease',
      flexShrink: 0,
    }}/>
  );
}

interface TrafficLightProps {
  phase: LightPhase;
  label: string;
  greenSecs: number;
  blinkOn: boolean;
}

function TrafficLight({ phase, label, greenSecs, blinkOn }: TrafficLightProps) {
  // Signal-off: blink amber
  const displayPhase = phase === 'off' ? (blinkOn ? 'amber' : 'none') : phase;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      userSelect: 'none',
    }}>
      {/* Direction badge */}
      <div style={{
        fontSize: 9, fontFamily: 'ui-monospace, monospace', fontWeight: 700,
        color: '#94a3b8', letterSpacing: '0.1em',
        background: '#1e293b', borderRadius: 3,
        padding: '1px 4px',
        border: '1px solid #334155',
      }}>
        {label}
      </div>

      {/* 3D scene - perspective wrapper */}
      <div style={{ perspective: '320px' }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          transformStyle: 'preserve-3d',
          transform: 'rotateX(8deg) rotateY(-28deg)',
        }}>
          {/* Pole */}
          <div style={{
            width: 5, height: 34,
            background: 'linear-gradient(90deg, #374151 0%, #9ca3af 40%, #6b7280 100%)',
            borderRadius: '3px 3px 0 0',
            flexShrink: 0,
          }}/>

          {/*
            Housing: fake 3D via perspective transform + layered box-shadow.
            The offset shadows create the illusion of left/bottom faces.
          */}
          <div style={{
            width: 40, height: 95,
            background: 'linear-gradient(155deg, #1e293b 0%, #0f172a 60%)',
            borderRadius: 5,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'space-evenly',
            padding: '10px 0',
            border: '1px solid rgba(255,255,255,0.06)',
            boxShadow: [
              '-11px 9px 0 #040912',   // far left/bottom face
              '-6px  5px 0 #0a1220',   // near left/bottom face
              'inset 2px 2px 0 rgba(255,255,255,0.04)',  // top-left glint
            ].join(', '),
            flexShrink: 0,
            position: 'relative',
          }}>
            <Lens on={displayPhase === 'red'}   color="#ef4444" glow="rgba(239,68,68,0.50)"  />
            <Lens on={displayPhase === 'amber'} color="#f59e0b" glow="rgba(245,158,11,0.50)" />
            <Lens on={displayPhase === 'green'} color="#22c55e" glow="rgba(34,197,94,0.50)"  />

            {/* Visor ridges between lenses - small cosmetic detail */}
            {([25, 50, 75] as const).map(top => (
              <div key={top} style={{
                position: 'absolute', left: 0, right: 0,
                top: `${top}%`, height: 1,
                background: 'rgba(255,255,255,0.04)',
              }}/>
            ))}
          </div>
        </div>
      </div>

      {/* Green time label */}
      <div style={{
        fontSize: 9, color: '#64748b',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: 'ui-monospace, monospace',
      }}>
        {phase === 'off' ? 'FLASH' : `${Math.round(greenSecs)}s`}
      </div>
    </div>
  );
}

// ── Intersection center graphic ───────────────────────────────────────────────

function IntersectionCenter({ cycleLength, elapsed }: { cycleLength: number; elapsed: number }) {
  const pct = cycleLength > 0 ? (elapsed % cycleLength) / cycleLength : 0;
  const circumference = 2 * Math.PI * 22;
  const dash = pct * circumference;

  return (
    <div style={{
      width: 64, height: 64, position: 'relative',
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Cycle progress ring */}
      <svg width={64} height={64} style={{ position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)' }}>
        <circle cx={32} cy={32} r={22} fill="none" stroke="#1e293b" strokeWidth={3}/>
        <circle
          cx={32} cy={32} r={22}
          fill="none" stroke="#3b82f6" strokeWidth={3}
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
        />
      </svg>

      {/* Road cross */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Vertical */}
        <div style={{
          position: 'absolute', top: 6, bottom: 6,
          left: '50%', width: 10,
          transform: 'translateX(-50%)',
          background: '#334155', borderRadius: 2,
        }}/>
        {/* Horizontal */}
        <div style={{
          position: 'absolute', left: 6, right: 6,
          top: '50%', height: 10,
          transform: 'translateY(-50%)',
          background: '#334155', borderRadius: 2,
        }}/>
        {/* Center dot */}
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#475569', zIndex: 1,
        }}/>
      </div>

      {/* Elapsed label */}
      <div style={{
        position: 'absolute', bottom: -16,
        fontSize: 8, color: '#64748b',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: 'ui-monospace, monospace',
        whiteSpace: 'nowrap',
      }}>
        {Math.floor(elapsed % Math.max(cycleLength, 1))}s / {cycleLength}s
      </div>
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

interface IntersectionSignal3DProps {
  timing: TimingChunk;
  streets: Street[];
}

export function IntersectionSignal3D({ timing, streets }: IntersectionSignal3DProps) {
  const [simTime, setSimTime] = useState(0);
  const rafRef   = useRef<number>(0);
  const lastTRef = useRef<number>(0);

  // Real-time clock - 1 real second = 1 sim second
  useEffect(() => {
    setSimTime(0);
    lastTRef.current = performance.now();

    function tick(now: number) {
      const dt = Math.min((now - lastTRef.current) / 1000, 0.5);
      lastTRef.current = now;
      setSimTime(t => t + dt);
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [timing.id]);

  const splits   = timing.green_splits;
  const streetIds = Object.keys(splits).map(Number);

  // Only keep streets that belong to this intersection (matched by id in splits)
  const relevantStreets = streets.filter(s => streetIds.includes(s.id));

  const dirMap: Record<number, string> = {};
  for (const s of relevantStreets) dirMap[s.id] = s.arm_direction;

  const phases = buildPhases(streetIds, dirMap);

  // Blink state for signal-off mode (0.5 Hz → 1s on / 1s off)
  const blinkOn = Math.floor(simTime) % 2 === 0;

  // Build one entry per street with its current phase state
  const lights = streetIds.map(sid => {
    const street = relevantStreets.find(s => s.id === sid);
    const dir    = street?.arm_direction ?? 'unknown';
    return {
      sid,
      dir,
      label:     DIR_SHORT[dir] ?? '?',
      greenSecs: splits[String(sid)] ?? 0,
      phase:     phaseAt(simTime, phases, splits, sid, timing.signal_off),
    };
  });

  const byDir: Record<string, typeof lights[0]> = {};
  for (const l of lights) {
    // If two streets share a direction label, keep the higher-flow one
    if (!byDir[l.dir] || l.greenSecs > byDir[l.dir].greenSecs) byDir[l.dir] = l;
  }

  const nb = byDir['northbound'];
  const sb = byDir['southbound'];
  const eb = byDir['eastbound'];
  const wb = byDir['westbound'];

  const hasNS = nb || sb;
  const hasEW = eb || wb;

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column',
      alignItems: 'center', gap: 12,
      padding: '20px 24px 28px',
    }}>
      {timing.signal_off && (
        <div style={{
          fontSize: 10, color: '#f59e0b', fontWeight: 600,
          background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 4, padding: '2px 8px', letterSpacing: '0.05em',
        }}>
          SIGNAL OFF - FLASHING AMBER
        </div>
      )}

      {/* NB light */}
      {nb && (
        <TrafficLight phase={nb.phase} label={nb.label} greenSecs={nb.greenSecs} blinkOn={blinkOn}/>
      )}

      {/* Middle row: WB | center | EB */}
      {(hasEW || hasNS) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {wb ? (
            <TrafficLight phase={wb.phase} label={wb.label} greenSecs={wb.greenSecs} blinkOn={blinkOn}/>
          ) : (
            hasEW && <div style={{ width: 48 }}/>
          )}

          <IntersectionCenter cycleLength={timing.cycle_length} elapsed={simTime}/>

          {eb ? (
            <TrafficLight phase={eb.phase} label={eb.label} greenSecs={eb.greenSecs} blinkOn={blinkOn}/>
          ) : (
            hasEW && <div style={{ width: 48 }}/>
          )}
        </div>
      )}

      {/* SB light */}
      {sb && (
        <TrafficLight phase={sb.phase} label={sb.label} greenSecs={sb.greenSecs} blinkOn={blinkOn}/>
      )}

      {/* Fallback: no directional data - flat list */}
      {!hasNS && !hasEW && lights.length > 0 && (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
          {lights.map(l => (
            <TrafficLight key={l.sid} phase={l.phase} label={l.label} greenSecs={l.greenSecs} blinkOn={blinkOn}/>
          ))}
          <IntersectionCenter cycleLength={timing.cycle_length} elapsed={simTime}/>
        </div>
      )}

      {/* No data at all */}
      {lights.length === 0 && (
        <div style={{ fontSize: 11, color: '#64748b', textAlign: 'center', maxWidth: 200 }}>
          No timing data available for this chunk.
          <br/>Set arm directions on each street to enable signal simulation.
        </div>
      )}
    </div>
  );
}
