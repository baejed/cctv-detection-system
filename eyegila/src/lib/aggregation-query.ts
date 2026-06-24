import { aggregationApi } from '@/services/aggregation';
import type { AggregationRow } from '@/types';

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

export const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today',     label: 'Today'     },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d',        label: '7 days'    },
  { key: '30d',       label: '30 days'   },
  { key: 'custom',    label: 'Custom'    },
];

export type Bucket = 'hour' | 'day' | 'week';

/** Resolve a preset to absolute [start, end). `today` and `7d`/`30d` include
 *  the rest of the current day so callers don't need to add tomorrow. */
export function getPresetRange(preset: Preset): { start: Date; end: Date } {
  const now = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86_400_000);
  switch (preset) {
    case 'today':     return { start: today, end: tomorrow };
    case 'yesterday': return { start: new Date(today.getTime() - 86_400_000), end: today };
    case '7d':        return { start: new Date(today.getTime() -  7 * 86_400_000), end: tomorrow };
    case '30d':       return { start: new Date(today.getTime() - 30 * 86_400_000), end: tomorrow };
    default:          return { start: today, end: tomorrow };
  }
}

/** Pick the coarsest bucket that keeps the chart readable.
 *  ≤2 days → hour · ≤180 days → day · longer → week. */
export function getBucket(start: Date, end: Date): Bucket {
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days <= 2)   return 'hour';
  if (days <= 180) return 'day';
  return 'week';
}

export interface AggregationFilters {
  start: Date;
  end:   Date;
  bucket: Bucket;
  intersection_id?: number | null;
  street_id?:       number | null;
  direction?: 'inbound' | 'outbound' | 'unknown' | null;
}

/** Fetch aggregation history for a filter set. Wraps aggregationApi so callers
 *  don't have to convert Date→string or re-derive the bucket. */
export function fetchAggregation(filters: AggregationFilters): Promise<AggregationRow[]> {
  return aggregationApi.history({
    start: filters.start.toISOString(),
    end:   filters.end.toISOString(),
    bucket: filters.bucket,
    intersection_id: filters.intersection_id ?? null,
    street_id:       filters.street_id ?? null,
    direction:       filters.direction ?? null,
  });
}
