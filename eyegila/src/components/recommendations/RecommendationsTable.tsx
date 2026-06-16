import { Link } from 'react-router-dom';
import { type RecommendationResponse } from '@/services/recommendations';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CheckCircle2, RefreshCw, Loader2, ArrowUp, ArrowDown, BarChart2 } from 'lucide-react';
import { statusBucket, BUCKET_LABEL, BUCKET_BADGE_CLASS } from './statusBucket';

export type SortKey =
  | 'name' | 'status'
  | 'w1' | 'w2' | 'w4'
  | 'wl1' | 'wl2' | 'wl3'
  | 'major' | 'peds' | 'timing' | 'generated';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface Props {
  rows: RecommendationResponse[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  onRowClick: (rec: RecommendationResponse) => void;
  onRegenerate: (intersectionId: number) => void;
  regeneratingIds: Set<number>;
}

const STATUS_ORDER: Record<ReturnType<typeof statusBucket>, number> = {
  warranted: 0, borderline: 1, not_warranted: 2, no_data: 3,
};

export function RecommendationsTable({
  rows, sort, onSortChange, onRowClick, onRegenerate, regeneratingIds,
}: Props) {
  function toggleSort(key: SortKey) {
    if (sort.key === key) onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else onSortChange({ key, dir: key === 'name' ? 'asc' : 'desc' });
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <Th label="Intersection"  k="name"      sort={sort} onClick={toggleSort} />
            <Th label="Status"        k="status"    sort={sort} onClick={toggleSort} />
            <Th label="W1"            k="w1"        sort={sort} onClick={toggleSort} numeric />
            <Th label="W2"            k="w2"        sort={sort} onClick={toggleSort} numeric />
            <Th label="W4"            k="w4"        sort={sort} onClick={toggleSort} numeric />
            <Th label="WL1"           k="wl1"       sort={sort} onClick={toggleSort} />
            <Th label="WL2"           k="wl2"       sort={sort} onClick={toggleSort} />
            <Th label="WL3"           k="wl3"       sort={sort} onClick={toggleSort} />
            <Th label="Major /hr"     k="major"     sort={sort} onClick={toggleSort} numeric />
            <Th label="Peds /hr"      k="peds"      sort={sort} onClick={toggleSort} numeric />
            <Th label="Timing"        k="timing"    sort={sort} onClick={toggleSort} />
            <Th label="Generated"     k="generated" sort={sort} onClick={toggleSort} />
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(rec => {
            const bucket = statusBucket(rec);
            const isRegenerating = regeneratingIds.has(rec.intersection_id);
            return (
              <TableRow
                key={rec.intersection_id}
                onClick={() => onRowClick(rec)}
                className="cursor-pointer hover:bg-muted/40"
              >
                <TableCell className="font-medium">{rec.intersection_name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn('text-[10px]', BUCKET_BADGE_CLASS[bucket])}>
                    {BUCKET_LABEL[bucket]}
                  </Badge>
                </TableCell>
                <ProbCell met={rec.warrant_1_met} value={rec.warrant_1_confidence} />
                <ProbCell met={rec.warrant_2_met} value={rec.warrant_2_confidence} />
                <ProbCell met={rec.warrant_4_met} value={rec.warrant_4_confidence} />
                <LocalWarrantCell met={rec.w_local_1_met} label="WL1" title="High motorcycle/pedicab ratio" />
                <LocalWarrantCell met={rec.w_local_2_met} label="WL2" title="Peak volume concentration" />
                <LocalWarrantCell met={rec.w_local_3_met} label="WL3" title="Low PCU / lights off" />
                <NumCell value={rec.major_volume} />
                <NumCell value={rec.peds} />
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {rec.timing_cycle != null
                    ? `${rec.timing_cycle}s${rec.timing_chunk ? ` (${rec.timing_chunk})` : ''}`
                    : '-'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" title={new Date(rec.generated_at).toLocaleString()}>
                  {relativeTime(rec.generated_at)}
                </TableCell>
                <TableCell onClick={e => e.stopPropagation()} className="flex gap-1">
                  {rec.timing_cycle != null && (
                    <Link to={`/timing/${rec.intersection_id}`} tabIndex={-1}>
                      <Button size="icon" variant="ghost" className="size-7" aria-label="View timing">
                        <BarChart2 className="size-3.5" />
                      </Button>
                    </Link>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Regenerate"
                    disabled={isRegenerating}
                    onClick={() => onRegenerate(rec.intersection_id)}
                  >
                    {isRegenerating
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <RefreshCw className="size-3.5" />}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Th({
  label, k, sort, onClick, numeric,
}: {
  label: string; k: SortKey; sort: SortState; onClick: (k: SortKey) => void; numeric?: boolean;
}) {
  const active = sort.key === k;
  return (
    <TableHead
      onClick={() => onClick(k)}
      className={cn('cursor-pointer select-none whitespace-nowrap', numeric && 'text-right')}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </span>
    </TableHead>
  );
}

function ProbCell({ met, value }: { met: boolean; value: number }) {
  return (
    <TableCell className={cn('text-right tabular-nums', met ? 'text-emerald-600 font-semibold' : 'text-muted-foreground')}>
      <span className="inline-flex items-center gap-1 justify-end">
        {met && <CheckCircle2 className="size-3" />}
        {value.toFixed(2)}
      </span>
    </TableCell>
  );
}

function NumCell({ value }: { value: number | null }) {
  return (
    <TableCell className="text-right tabular-nums text-muted-foreground">
      {value ?? '-'}
    </TableCell>
  );
}

function LocalWarrantCell({ met, label, title }: { met: boolean | null; label: string; title: string }) {
  if (met === null || met === undefined) {
    return <TableCell className="text-center"><span className="text-muted-foreground text-[10px]">-</span></TableCell>;
  }
  return (
    <TableCell className="text-center">
      <Badge
        variant="outline"
        title={title}
        className={cn(
          'text-[10px] px-1.5 py-0',
          met
            ? 'border-emerald-500 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30'
            : 'border-border text-muted-foreground',
        )}
      >
        {label}
      </Badge>
    </TableCell>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function sortRows(rows: RecommendationResponse[], sort: SortState): RecommendationResponse[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'name':      return sign * a.intersection_name.localeCompare(b.intersection_name);
      case 'status': {
        const cmp = STATUS_ORDER[statusBucket(a)] - STATUS_ORDER[statusBucket(b)];
        if (cmp !== 0) return sign * cmp;
        // Tiebreaker is fixed descending by design - within any bucket, the strongest
        // recommended_confidence sorts first regardless of the user's chosen status sort
        // direction. The spec calls for "Warranted first, then recommended_confidence
        // descending" and inverting the inner sort on a desc click would scatter weak
        // recommendations to the top of the warranted bucket.
        return (b.recommended_confidence ?? 0) - (a.recommended_confidence ?? 0);
      }
      case 'w1':        return sign * (a.warrant_1_confidence - b.warrant_1_confidence);
      case 'w2':        return sign * (a.warrant_2_confidence - b.warrant_2_confidence);
      case 'w4':        return sign * (a.warrant_4_confidence - b.warrant_4_confidence);
      case 'wl1':       return sign * ((a.w_local_1_confidence ?? -1) - (b.w_local_1_confidence ?? -1));
      case 'wl2':       return sign * ((a.w_local_2_confidence ?? -1) - (b.w_local_2_confidence ?? -1));
      case 'wl3':       return sign * ((a.w_local_3_confidence ?? -1) - (b.w_local_3_confidence ?? -1));
      case 'major':     return sign * ((a.major_volume ?? -1) - (b.major_volume ?? -1));
      case 'peds':      return sign * ((a.peds ?? -1) - (b.peds ?? -1));
      case 'timing':    return sign * ((a.timing_cycle ?? -1) - (b.timing_cycle ?? -1));
      case 'generated': return sign * (new Date(a.generated_at).getTime() - new Date(b.generated_at).getTime());
    }
  });
}
