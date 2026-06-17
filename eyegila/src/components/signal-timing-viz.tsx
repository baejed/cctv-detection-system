import { cn } from '@/lib/utils';

export const ARM_SHORT: Record<string, string> = {
  northbound: 'N', southbound: 'S', eastbound: 'E', westbound: 'W', unknown: '?',
};

export const YELLOW_S = 3;

const LOS_COLORS: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  B: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  C: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  D: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  E: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  F: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

export function LosBadge({ grade }: { grade: string }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums', LOS_COLORS[grade] ?? '')}>
      {grade}
    </span>
  );
}

export function GanttBar({ label, greenSec, cycleLength }: { label: string; greenSec: number; cycleLength: number }) {
  const redSec = Math.max(0, cycleLength - greenSec - YELLOW_S);
  const greenPct = (greenSec / cycleLength) * 100;
  const yellowPct = (YELLOW_S / cycleLength) * 100;
  const redPct = (redSec / cycleLength) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-24 shrink-0 truncate" title={label}>{label}</span>
      <div className="flex flex-1 rounded overflow-hidden h-5">
        <div
          style={{ width: `${greenPct}%` }}
          className="bg-emerald-500 flex items-center justify-center text-[10px] text-white font-medium"
          title={`Green: ${greenSec.toFixed(0)}s`}
        >
          {greenPct > 10 ? `${greenSec.toFixed(0)}s` : ''}
        </div>
        <div
          style={{ width: `${yellowPct}%` }}
          className="bg-amber-400"
          title={`Yellow: ${YELLOW_S}s`}
        />
        <div
          style={{ width: `${redPct}%` }}
          className="bg-rose-400/40 flex items-center justify-center text-[10px] text-rose-700 dark:text-rose-300"
          title={`Red: ${redSec.toFixed(0)}s`}
        >
          {redPct > 15 ? `${redSec.toFixed(0)}s` : ''}
        </div>
      </div>
    </div>
  );
}

export function GanttDiagram({
  title,
  cycleLength,
  approaches,
  titleClassName,
}: {
  title: string;
  cycleLength: number;
  approaches: { label: string; greenSec: number }[];
  titleClassName?: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <p className={cn('text-xs font-semibold text-center', titleClassName ?? 'text-foreground')}>{title}</p>
      <p className="text-[10px] text-muted-foreground text-center mb-3">{cycleLength}s cycle</p>
      <div className="space-y-2">
        {approaches.map(a => <GanttBar key={a.label} {...a} cycleLength={cycleLength} />)}
      </div>
    </div>
  );
}
