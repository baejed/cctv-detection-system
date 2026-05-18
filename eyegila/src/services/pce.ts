import { request } from './api';

export type PceTier = 'default' | 'calibrated' | 'override';

export interface PceValue {
  vehicle_type: string;
  pce: number;
  tier: PceTier;
}

export interface PceResolved {
  intersection_id: number;
  values: PceValue[];
}

export const pceApi = {
  get: (id: number) =>
    request<PceResolved>(`/intersections/${id}/pce`),

  setOverride: (id: number, vehicle_type: string, pce_value: number) =>
    request<PceResolved>(`/intersections/${id}/pce/overrides`, {
      method: 'POST',
      body: JSON.stringify({ vehicle_type, pce_value }),
    }),

  deleteOverride: (id: number, vehicle_type: string) =>
    request<PceResolved>(`/intersections/${id}/pce/overrides/${vehicle_type}`, {
      method: 'DELETE',
    }),

  calibrate: (id: number) =>
    request<PceResolved>(`/intersections/${id}/pce/calibrate`, { method: 'POST' }),
};
