import { request, getToken } from './api';
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

  retry: (id: number) =>
    request<void>(`/cctvs/${id}/retry`, { method: 'POST' }),

  disable: (id: number) =>
    request<void>(`/cctvs/${id}/disable`, { method: 'POST' }),

  enable: (id: number) =>
    request<void>(`/cctvs/${id}/enable`, { method: 'POST' }),

  snapshotUrl: (id: number) => {
    const token = getToken();
    // Without a token the server returns 401 - let the <img onError> show
    // the placeholder instead of issuing a doomed request.
    if (!token) return '';
    const q = `?token=${encodeURIComponent(token)}`;
    return import.meta.env.DEV
      ? `http://${window.location.hostname}:8000/cctvs/${id}/snapshot${q}`
      : `/api/cctvs/${id}/snapshot${q}`;
  },

  scanNvr: (data: { host: string; username: string; password: string; max_channels: number; subtype: number }) =>
    request<{ reachable: boolean; channels: { channel: number; rtsp_url: string }[] }>('/cctvs/scan-nvr', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  discover: () =>
    request<{ address: string; rtsp_url: string | null; xaddrs: string[] }[]>('/cctvs/discover'),
};
