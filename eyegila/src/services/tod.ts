import { request } from './api';
import type { TodChunk } from '../types';

export const todApi = {
  list: (intersectionId: number) =>
    request<TodChunk[]>(`/intersections/${intersectionId}/tod-chunks`),

  update: (intersectionId: number, chunkId: number, data: { name: string; start_time: string; end_time: string }) =>
    request<TodChunk[]>(`/intersections/${intersectionId}/tod-chunks/${chunkId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  active: (intersectionId: number, ts: string) =>
    request<TodChunk | null>(`/intersections/${intersectionId}/tod-chunks/active?ts=${encodeURIComponent(ts)}`),
};
