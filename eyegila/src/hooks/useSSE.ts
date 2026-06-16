import { useEffect, useRef, useState } from 'react';
import { getToken, triggerUnauthorized } from '../services/api';

export type SSEStatus = 'connecting' | 'connected' | 'disconnected' | 'server_offline';

const MAX_RETRY_MS = 30_000;

export function useSSE<T>(url: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<SSEStatus>('disconnected');

  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1_000);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setStatus('disconnected');
      return;
    }

    async function connect() {
      if (!enabledRef.current) return;

      setStatus('connecting');
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const token = getToken();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(url, { headers, signal: controller.signal });

        if (res.status === 401) {
          triggerUnauthorized();
          return;
        }

        if (!res.ok || !res.body) {
          setStatus('server_offline');
        } else {
          setStatus('connected');
          retryDelayRef.current = 1_000;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) { setData(null); break; }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!;

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  setData(JSON.parse(line.slice(6)) as T);
                } catch {
                  // malformed JSON — ignore
                }
              }
            }
          }

          setStatus('disconnected');
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (!enabledRef.current) return;
        setStatus('disconnected');
      }

      if (!enabledRef.current) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
      retryTimerRef.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [url, enabled]);

  return { data, status };
}
