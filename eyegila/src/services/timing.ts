import { request } from './api';

export interface TimingChunk {
  id: number;
  intersection_id: number;
  recommendation_id: number;
  chunk_name: string;
  cycle_length: number;
  green_splits: Record<string, number>;
  effective_date: string;
  pce_tier_used: string;
  signal_off: boolean;
  generated_at: string;
  measured_flows: Record<string, number> | null;
  assumptions: Record<string, number | string> | null;
}

export const timingApi = {
  list: (intersectionId: number) =>
    request<TimingChunk[]>(`/timing-recommendations/${intersectionId}`),
};
