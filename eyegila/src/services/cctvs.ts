import { request } from './api';
import type { CCTV } from '../types';

export const cctvsApi = {
  list: () => request<CCTV[]>('/cctvs/'),

  get: (id: number) => request<CCTV>(`/cctvs/${id}`),

  create: (data: { intersection_id: number; name: string; rtsp_url: string }) =>
    request<CCTV>('/cctvs/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<{ name: string; rtsp_url: string; intersection_id: number }>) =>
    request<CCTV>(`/cctvs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<{ detail: string }>(`/cctvs/${id}`, { method: 'DELETE' }),

  snapshotUrl: (id: number) =>
    import.meta.env.DEV
      ? `http://${window.location.hostname}:8000/cctvs/${id}/snapshot`
      : `/api/cctvs/${id}/snapshot`,

  scanNvr: (data: { host: string; username: string; password: string; max_channels: number; subtype: number }) =>
    request<{ reachable: boolean; channels: { channel: number; rtsp_url: string }[] }>('/cctvs/scan-nvr', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
