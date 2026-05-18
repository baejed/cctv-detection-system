import { request } from './api';

export interface SimulationChunk {
  chunk_name: string;
  delay_before: number;
  delay_after: number;
  volume_pcu_hr: number;
  vehicle_hours_saved: number;
  queue_series_before: Record<string, number[]> | null;
  queue_series_after: Record<string, number[]> | null;
  generated_at: string;
}

export interface DailySummary {
  total_vehicle_hours_saved: number;
  avg_delay_before: number;
  avg_delay_after: number;
  total_volume_pcu_hr: number;
}

export interface SimulationResponse {
  intersection_id: number;
  intersection_name: string;
  signal_status: string;
  chunks: SimulationChunk[];
  daily_summary: DailySummary;
}

export const simulationApi = {
  get: (intersectionId: number) =>
    request<SimulationResponse>(`/simulation/${intersectionId}`),
};
