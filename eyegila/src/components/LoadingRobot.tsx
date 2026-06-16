import React from 'react';
import { cn } from '@/lib/utils';

interface LoadingRobotProps {
  message?: string;
  size?: number;
  className?: string;
}

export function LoadingRobot({ message = 'Processing...', size = 130, className }: LoadingRobotProps) {
  const h = Math.round(size * 1.6);

  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      <svg
        width={size}
        height={h}
        viewBox="0 0 130 208"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Loading"
        role="img"
      >
        <defs>
          <radialGradient id="rl-eyeglow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#2563eb" />
          </radialGradient>
          <filter id="rl-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="rl-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1e3a8a" />
            <stop offset="100%" stopColor="#172554" />
          </linearGradient>
        </defs>

        <style>{`
          @keyframes rl-bounce {
            0%,100% { transform: translateY(0); }
            50%      { transform: translateY(-5px); }
          }
          @keyframes rl-arm-l {
            0%,100% { transform: translateY(0); }
            50%      { transform: translateY(-7px); }
          }
          @keyframes rl-arm-r {
            0%,100% { transform: translateY(-7px); }
            50%      { transform: translateY(0); }
          }
          @keyframes rl-blink {
            0%,85%,100% { transform: scaleY(1); }
            90%          { transform: scaleY(0.08); }
          }
          @keyframes rl-antenna {
            0%,100% { opacity: 0.6; r: 4.5; }
            50%      { opacity: 1;   r: 6;   }
          }
          @keyframes rl-dot {
            0%,70%,100% { opacity: 0.15; }
            35%          { opacity: 1; }
          }
          @keyframes rl-scanline {
            0%   { transform: translateY(0); opacity: 0.4; }
            100% { transform: translateY(28px); opacity: 0; }
          }

          .rl-body { animation: rl-bounce 2.2s ease-in-out infinite; }
          .rl-arm-l { animation: rl-arm-l 0.55s ease-in-out infinite; }
          .rl-arm-r { animation: rl-arm-r 0.55s ease-in-out infinite; }
          .rl-eye-l { transform-box: fill-box; transform-origin: center; animation: rl-blink 4s ease-in-out infinite; }
          .rl-eye-r { transform-box: fill-box; transform-origin: center; animation: rl-blink 4s ease-in-out infinite 0.2s; }
          .rl-ant   { animation: rl-antenna 1.1s ease-in-out infinite; }
          .rl-d1    { animation: rl-dot 1.4s ease-in-out infinite 0s; }
          .rl-d2    { animation: rl-dot 1.4s ease-in-out infinite 0.22s; }
          .rl-d3    { animation: rl-dot 1.4s ease-in-out infinite 0.44s; }
          .rl-scan  { animation: rl-scanline 1.8s linear infinite; }
        `}</style>

        {/* ── LEFT ARM (animates independently, no bounce) ── */}
        <g className="rl-arm-l">
          {/* upper arm */}
          <rect x="4" y="90" width="18" height="40" rx="9" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.5" />
          {/* hand */}
          <rect x="2" y="126" width="22" height="13" rx="6" fill="#1e293b" stroke="#334155" strokeWidth="1" />
        </g>

        {/* ── RIGHT ARM ── */}
        <g className="rl-arm-r">
          <rect x="108" y="90" width="18" height="40" rx="9" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.5" />
          <rect x="106" y="126" width="22" height="13" rx="6" fill="#1e293b" stroke="#334155" strokeWidth="1" />
        </g>

        {/* ── MAIN BODY GROUP (bounces) ── */}
        <g className="rl-body">

          {/* Antenna */}
          <line x1="65" y1="22" x2="65" y2="9" stroke="#475569" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="65" cy="6" r="4.5" fill="#3b82f6" filter="url(#rl-glow)" className="rl-ant" />

          {/* Head */}
          <rect x="29" y="22" width="72" height="52" rx="14" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.8" />

          {/* Visor screen */}
          <rect x="37" y="31" width="56" height="28" rx="8" fill="#020617" />
          <rect x="37" y="31" width="56" height="28" rx="8" fill="none" stroke="#1e3a8a" strokeWidth="1" opacity="0.9" />
          {/* scan line across visor */}
          <rect x="37" y="31" width="56" height="3" rx="1.5" fill="#3b82f6" opacity="0.25" className="rl-scan" />

          {/* Eyes */}
          <g className="rl-eye-l">
            <circle cx="54" cy="45" r="7.5" fill="url(#rl-eyeglow)" filter="url(#rl-glow)" />
            <circle cx="54" cy="45" r="2.8" fill="white" opacity="0.55" />
          </g>
          <g className="rl-eye-r">
            <circle cx="76" cy="45" r="7.5" fill="url(#rl-eyeglow)" filter="url(#rl-glow)" />
            <circle cx="76" cy="45" r="2.8" fill="white" opacity="0.55" />
          </g>

          {/* Smile */}
          <path d="M 50 66 Q 65 74 80 66" stroke="#1d4ed8" strokeWidth="2.5" fill="none" strokeLinecap="round" />

          {/* Neck */}
          <rect x="56" y="74" width="18" height="12" rx="5" fill="#1e293b" />

          {/* Shoulder caps */}
          <ellipse cx="29" cy="92" rx="7" ry="6" fill="#1e293b" stroke="#334155" strokeWidth="1.2" />
          <ellipse cx="101" cy="92" rx="7" ry="6" fill="#1e293b" stroke="#334155" strokeWidth="1.2" />

          {/* Body torso */}
          <rect x="22" y="86" width="86" height="70" rx="16" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.8" />

          {/* Chest display panel */}
          <rect x="36" y="98" width="58" height="44" rx="9" fill="#020617" />
          <rect x="36" y="98" width="58" height="44" rx="9" fill="none" stroke="#1e3a8a" strokeWidth="1" />

          {/* Loading dots on chest */}
          <circle cx="51" cy="118" r="5" fill="#3b82f6" className="rl-d1" />
          <circle cx="65" cy="118" r="5" fill="#3b82f6" className="rl-d2" />
          <circle cx="79" cy="118" r="5" fill="#3b82f6" className="rl-d3" />

          {/* Progress bar */}
          <rect x="44" y="130" width="42" height="4" rx="2" fill="#1e3a8a" />
          <rect x="44" y="130" width="26" height="4" rx="2" fill="#3b82f6" opacity="0.75" />

          {/* Body rivets */}
          <circle cx="30" cy="99" r="3" fill="#1e293b" stroke="#334155" strokeWidth="1" />
          <circle cx="100" cy="99" r="3" fill="#1e293b" stroke="#334155" strokeWidth="1" />

          {/* Legs */}
          <rect x="34" y="154" width="24" height="38" rx="11" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.5" />
          <rect x="72" y="154" width="24" height="38" rx="11" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.5" />

          {/* Feet */}
          <rect x="26" y="183" width="36" height="14" rx="7" fill="#1e293b" stroke="#334155" strokeWidth="1" />
          <rect x="68" y="183" width="36" height="14" rx="7" fill="#1e293b" stroke="#334155" strokeWidth="1" />
        </g>
      </svg>

      {message && (
        <p className="text-xs text-muted-foreground tracking-widest uppercase font-medium animate-pulse">
          {message}
        </p>
      )}
    </div>
  );
}
