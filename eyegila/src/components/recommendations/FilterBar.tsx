import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type StatusBucket, BUCKET_LABEL } from './statusBucket';

export type WarrantKey = 'warrant_1' | 'warrant_2' | 'warrant_4';

export interface FilterState {
  statuses: Set<StatusBucket>;
  search: string;
  warrants: Set<WarrantKey>;
  minProb: number;
}

export const ALL_STATUSES: StatusBucket[] = ['warranted', 'borderline', 'not_warranted', 'no_data'];
export const ALL_WARRANTS: WarrantKey[] = ['warrant_1', 'warrant_2', 'warrant_4'];

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function FilterBar({ value, onChange }: Props) {
  function toggleStatus(s: StatusBucket) {
    const next = new Set(value.statuses);
    if (next.has(s)) next.delete(s); else next.add(s);
    onChange({ ...value, statuses: next });
  }
  function toggleWarrant(w: WarrantKey) {
    const next = new Set(value.warrants);
    if (next.has(w)) next.delete(w); else next.add(w);
    onChange({ ...value, warrants: next });
  }
  const sliderDisabled = value.warrants.size === 0;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5">
        {ALL_STATUSES.map(s => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={value.statuses.has(s) ? 'default' : 'outline'}
            className="h-7 px-2.5 text-xs"
            onClick={() => toggleStatus(s)}
          >
            {BUCKET_LABEL[s]}
          </Button>
        ))}
      </div>

      <div className="h-5 w-px bg-border" />

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide">Warrant</span>
        {ALL_WARRANTS.map(w => (
          <Button
            key={w}
            type="button"
            size="sm"
            variant={value.warrants.has(w) ? 'default' : 'outline'}
            className="h-7 px-2.5 text-xs"
            onClick={() => toggleWarrant(w)}
          >
            {w === 'warrant_1' ? 'W1' : w === 'warrant_2' ? 'W2' : 'W4'}
          </Button>
        ))}
      </div>

      <div className={cn('flex items-center gap-2', sliderDisabled && 'opacity-50')}>
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide">Min prob</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value.minProb}
          disabled={sliderDisabled}
          onChange={e => onChange({ ...value, minProb: Number(e.target.value) })}
          className="w-28 accent-foreground"
        />
        <span className="text-xs tabular-nums w-8 text-right">{value.minProb.toFixed(2)}</span>
      </div>

      <Input
        placeholder="Search intersections…"
        value={value.search}
        onChange={e => onChange({ ...value, search: e.target.value })}
        className="ml-auto h-7 max-w-[220px] text-xs"
      />
    </div>
  );
}
