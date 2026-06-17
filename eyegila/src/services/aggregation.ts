import { request } from './api';
import type { AggregationRow } from '@/types';

export const aggregationApi = {
  history(params: {
    start: string;
    end: string;
    intersection_id?: number | null;
    street_id?: number | null;
    direction?: 'inbound' | 'outbound' | 'unknown' | null;
    bucket?: 'hour' | 'day' | 'week';
  }): Promise<AggregationRow[]> {
    const q = new URLSearchParams({ start: params.start, end: params.end });
    if (params.bucket) q.set('bucket', params.bucket);
    if (params.intersection_id) q.set('intersection_id', String(params.intersection_id));
    if (params.street_id) q.set('street_id', String(params.street_id));
    if (params.direction) q.set('direction', params.direction);
    return request(`/aggregation/history?${q}`);
  },
};
