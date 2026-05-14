export interface User {
  id: number;
  username: string;
  time: string;
}

export interface Intersection {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  time: string;
}

export interface Street {
  id: number;
  intersection_id: number;
  name: string;
  time: string;
}

export interface CCTV {
  id: number;
  intersection_id: number;
  name: string;
  rtsp_url: string;
  status: 'online' | 'offline' | 'reconnecting';
  is_being_viewed: boolean;
  time: string;
}

export interface Region {
  id: number;
  cctv_id: number;
  street_id: number;
  direction: 'inbound' | 'outbound' | 'unknown';
  region_points: RegionPoint[];
  time: string;
}

export interface RegionPoint {
  x: number;
  y: number;
}

export interface Detection {
  id: number;
  cctv_id: number;
  type: string;
  time: string;
}

export interface Video {
  video_id: number;
  filename: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  total_frames: number | null;
  processed_frames: number;
  uploaded_at: string;
  processed_at: string | null;
}

export interface VideoStatus {
  video_id: number;
  status: string;
  total_frames: number | null;
  processed_frames: number;
  percent: number;
  processed_at: string | null;
}

export interface AggregationRow {
  intersection_id: number;
  intersection_name: string;
  street_id: number | null;  // null = camera has no regions (intersection-level count)
  direction: 'inbound' | 'outbound' | 'unknown';
  object_type: string;
  window_start: string;
  count: number;
}

export interface Recommendation {
  id: number;
  intersection_id: number;
  warrant_1_met: boolean;
  warrant_1_confidence: number;
  warrant_2_met: boolean;
  warrant_2_confidence: number;
  warrant_4_met: boolean;
  warrant_4_confidence: number;
  recommended: boolean;
  recommended_confidence: number | null;
  major_volume: number | null;
  minor_volume: number | null;
  peds: number | null;
  vpm: number | null;
  phf: number | null;
  hour_start: string | null;
  notes: string | null;
  generated_at: string;
}
