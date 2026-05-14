import { type StatusBucket, BUCKET_LABEL } from './statusBucket';

interface Props {
  counts: Record<StatusBucket, number>;
  totalIntersections: number;
}

const ORDER: StatusBucket[] = ['warranted', 'borderline', 'not_warranted', 'no_data'];

const COLOR: Record<StatusBucket, string> = {
  warranted: 'text-emerald-600',
  borderline: 'text-amber-600',
  not_warranted: 'text-foreground',
  no_data: 'text-rose-600',
};

export function SummaryStrip({ counts, totalIntersections }: Props) {
  const analyzed = ORDER.reduce((s, k) => s + counts[k], 0);
  const notAnalyzed = totalIntersections - analyzed;

  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-card px-5 py-3 text-sm">
      {ORDER.map(k => (
        <div key={k} className="flex items-center gap-1.5">
          <span className={`text-lg font-bold tabular-nums ${COLOR[k]}`}>{counts[k]}</span>
          <span className="text-muted-foreground">{BUCKET_LABEL[k].toLowerCase()}</span>
        </div>
      ))}
      {notAnalyzed > 0 && (
        <div className="ml-auto text-xs text-muted-foreground">
          {notAnalyzed} intersection{notAnalyzed === 1 ? '' : 's'} not yet analyzed
        </div>
      )}
    </div>
  );
}
