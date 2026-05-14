import { request } from './api';
import type { Recommendation } from '@/types';

export interface RecommendationResponse extends Recommendation {
  intersection_name: string;
}

export const recommendationsApi = {
  list(): Promise<RecommendationResponse[]> {
    return request('/recommendations/');
  },
  generate(intersectionId: number): Promise<RecommendationResponse> {
    return request(`/recommendations/${intersectionId}`, { method: 'POST' });
  },
  generateAll(): Promise<RecommendationResponse[]> {
    return request('/recommendations/bulk', { method: 'POST' });
  },
  history(intersectionId: number, limit = 50): Promise<RecommendationResponse[]> {
    return request(`/recommendations/history/${intersectionId}?limit=${limit}`);
  },
  updateNotes(id: number, notes: string | null): Promise<RecommendationResponse> {
    return request(`/recommendations/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
  },
};
