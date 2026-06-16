// Seed from localStorage so HMR module replacement doesn't lose the token
// between the module reset and AuthContext re-mounting.
let _token: string | null = localStorage.getItem('eyegila_token');
let _onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  _token = t;
}

export function getToken(): string | null {
  return _token;
}

/** Registered by AuthContext. Called on any 401 response to evict the session. */
export function setUnauthorizedHandler(fn: () => void) {
  _onUnauthorized = fn;
}

/** Called by non-fetch connections (e.g. SSE) that detect a 401 out-of-band. */
export function triggerUnauthorized() {
  _onUnauthorized?.();
}

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  // Allow overriding the token (e.g. admin key for /users/)
  authToken?: string;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { skipAuth, authToken, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  // Don't set Content-Type if sending FormData
  if (!(fetchOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const token = authToken ?? (skipAuth ? null : _token);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, { ...fetchOptions, headers });

  if (!res.ok) {
    if (res.status === 401 && !skipAuth) {
      _onUnauthorized?.();
    }
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error body
    }
    const err = new Error(detail) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  // 204 No Content
  if (res.status === 204) return null as T;

  return res.json();
}
