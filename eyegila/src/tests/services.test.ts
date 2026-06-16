/**
 * Unit tests for frontend service modules.
 *
 * These run in jsdom via Vitest.  `fetch` is mocked so no real server is needed.
 * Tests verify:
 *   - API paths are constructed correctly
 *   - Auth header is attached when a token is set
 *   - 401 responses invoke the unauthorized handler
 *   - 404 / 422 responses throw with the detail message
 *   - 204 No Content returns null without crashing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setToken, setUnauthorizedHandler, request } from '../services/api';

// ─── Helper: mock fetch ───────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, contentType = 'application/json') {
  const json = typeof body === 'string' ? () => Promise.reject() : () => Promise.resolve(body);
  const text = () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers({ 'Content-Type': contentType }),
    json,
    text,
  } as unknown as Response);
}

beforeEach(() => {
  setToken(null);
  setUnauthorizedHandler(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── request() core behaviour ─────────────────────────────────────────────────

describe('request()', () => {
  it('calls /api prefix + given path', async () => {
    mockFetch(200, { id: 1 });
    await request('/intersections/');
    const called = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(called).toBe('/api/intersections/');
  });

  it('sets Content-Type: application/json by default', async () => {
    mockFetch(200, {});
    await request('/test/');
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('attaches Bearer token from setToken()', async () => {
    setToken('my-jwt');
    mockFetch(200, {});
    await request('/intersections/');
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer my-jwt');
  });

  it('does not attach Authorization header when no token', async () => {
    setToken(null);
    mockFetch(200, {});
    await request('/intersections/');
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((opts.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('returns parsed JSON on 200', async () => {
    const payload = { id: 42, name: 'Magugpo Junction' };
    mockFetch(200, payload);
    const result = await request('/intersections/42');
    expect(result).toEqual(payload);
  });

  it('returns null on 204 No Content', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 204, statusText: 'No Content',
      json: () => Promise.reject(), text: () => Promise.resolve(''),
    } as unknown as Response);
    const result = await request('/something/');
    expect(result).toBeNull();
  });

  it('throws on 404 with detail message from JSON body', async () => {
    mockFetch(404, { detail: 'Intersection not found' });
    await expect(request('/intersections/999')).rejects.toThrow('Intersection not found');
  });

  it('throws on 422 with detail key', async () => {
    mockFetch(422, { detail: [{ msg: 'field required', loc: ['body', 'latitude'] }] });
    await expect(request('/intersections/', { method: 'POST' })).rejects.toThrow();
  });

  it('calls unauthorized handler on 401', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setToken('old-token');
    mockFetch(401, { detail: 'Not authenticated' });
    await expect(request('/intersections/')).rejects.toThrow();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does NOT call unauthorized handler when skipAuth=true on 401', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockFetch(401, { detail: 'Not authenticated' });
    await expect(request('/login', { method: 'POST', skipAuth: true })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses authToken override instead of stored token', async () => {
    setToken('stored-token');
    mockFetch(200, {});
    await request('/intersections/', { authToken: 'override-token' });
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer override-token');
  });

  it('does not set Content-Type for FormData bodies', async () => {
    mockFetch(200, {});
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'test.mp4');
    await request('/videos/upload', { method: 'POST', body: fd });
    const opts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect((opts.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

// ─── Services call the right paths ───────────────────────────────────────────

describe('streetsApi', () => {
  beforeEach(() => setToken('tok'));

  it('.list() → GET /streets/', async () => {
    mockFetch(200, []);
    const { streetsApi } = await import('../services/streets');
    await streetsApi.list();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/streets/');
  });

  it('.get(5) → GET /streets/5', async () => {
    mockFetch(200, { id: 5 });
    const { streetsApi } = await import('../services/streets');
    await streetsApi.get(5);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/streets/5');
  });

  it('.create() → POST /streets/', async () => {
    mockFetch(200, { id: 9 });
    const { streetsApi } = await import('../services/streets');
    await streetsApi.create({ intersection_id: 1, name: 'NB St', arm_direction: 'northbound' });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/streets/');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.arm_direction).toBe('northbound');
  });

  it('.delete(3) → DELETE /streets/3', async () => {
    mockFetch(200, { detail: 'deleted' });
    const { streetsApi } = await import('../services/streets');
    await streetsApi.delete(3);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/streets/3');
    expect(opts.method).toBe('DELETE');
  });
});

describe('recommendationsApi', () => {
  beforeEach(() => setToken('tok'));

  it('.list() → GET /recommendations/', async () => {
    mockFetch(200, []);
    const { recommendationsApi } = await import('../services/recommendations');
    await recommendationsApi.list();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/recommendations/');
  });

  it('.generate(7) → POST /recommendations/generate/7', async () => {
    mockFetch(200, { id: 1, recommended: true });
    const { recommendationsApi } = await import('../services/recommendations');
    await recommendationsApi.generate(7);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/recommendations/generate/7');
    expect(opts.method).toBe('POST');
  });

  it('.generateAll() → POST /recommendations/generate-all', async () => {
    mockFetch(200, []);
    const { recommendationsApi } = await import('../services/recommendations');
    await recommendationsApi.generateAll();
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/recommendations/generate-all');
    expect(opts.method).toBe('POST');
  });

  it('.history(3, 10) → GET /recommendations/history/3?limit=10', async () => {
    mockFetch(200, []);
    const { recommendationsApi } = await import('../services/recommendations');
    await recommendationsApi.history(3, 10);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('/api/recommendations/history/3?limit=10');
  });

  it('.updateNotes(1, "check") → PATCH /recommendations/1/notes', async () => {
    mockFetch(200, { id: 1, notes: 'check' });
    const { recommendationsApi } = await import('../services/recommendations');
    await recommendationsApi.updateNotes(1, 'check');
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/recommendations/1/notes');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body).notes).toBe('check');
  });
});

describe('simulationApi', () => {
  beforeEach(() => setToken('tok'));

  it('.get(12) → GET /simulation/12', async () => {
    mockFetch(200, { intersection_id: 12, chunks: [], daily_summary: {} });
    const { simulationApi } = await import('../services/simulation');
    await simulationApi.get(12);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/simulation/12');
  });
});

describe('timingApi', () => {
  beforeEach(() => setToken('tok'));

  it('.list(5) → GET /timing-recommendations/5', async () => {
    mockFetch(200, []);
    const { timingApi } = await import('../services/timing');
    await timingApi.list(5);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe('/api/timing-recommendations/5');
  });
});

describe('cctvsApi', () => {
  beforeEach(() => setToken('tok'));

  it('.list() → GET /cctvs/', async () => {
    mockFetch(200, []);
    const { cctvsApi } = await import('../services/cctvs');
    await cctvsApi.list();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/cctvs/');
  });

  it('.get(3) → GET /cctvs/3', async () => {
    mockFetch(200, { id: 3 });
    const { cctvsApi } = await import('../services/cctvs');
    await cctvsApi.get(3);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/cctvs/3');
  });

  it('.create() → POST /cctvs/', async () => {
    mockFetch(200, { id: 7 });
    const { cctvsApi } = await import('../services/cctvs');
    await cctvsApi.create({ intersection_id: 1, name: 'Cam A', rtsp_url: 'rtsp://10.0.0.1/live' });
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/cctvs/');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.rtsp_url).toBe('rtsp://10.0.0.1/live');
  });

  it('.delete(3) → DELETE /cctvs/3', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 204, statusText: 'No Content',
      json: () => Promise.reject(), text: () => Promise.resolve(''),
    } as unknown as Response);
    const { cctvsApi } = await import('../services/cctvs');
    const result = await cctvsApi.delete(3);
    const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/cctvs/3');
    expect(opts.method).toBe('DELETE');
    expect(result).toBeNull();
  });

  it('.discover() → GET /cctvs/discover', async () => {
    const payload = [{ address: '192.168.1.50', rtsp_url: 'rtsp://192.168.1.50/live', xaddrs: [] }];
    mockFetch(200, payload);
    const { cctvsApi } = await import('../services/cctvs');
    const result = await cctvsApi.discover();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/cctvs/discover');
    expect(result).toEqual(payload);
  });

  it('.discover() returns empty array when no cameras found', async () => {
    mockFetch(200, []);
    const { cctvsApi } = await import('../services/cctvs');
    const result = await cctvsApi.discover();
    expect(result).toEqual([]);
  });
});
