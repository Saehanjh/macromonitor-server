import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import * as cache from './cache';

const inflight = new Map<string, Promise<unknown>>();

export interface ProxyFetchOptions {
  key: string;
  url: string;
  ttlSec: number;
  axiosConfig?: AxiosRequestConfig;
  /**
   * Optional provider-specific gate. It is intentionally called only for a
   * cache miss/background refresh, never for a cache hit, so an upstream
   * provider cannot be hammered by several public API requests at once.
   */
  beforeFetch?: () => Promise<void>;
}

export interface ProxyResult<T> {
  data: T;
  source: 'fresh' | 'cache' | 'stale';
  fetchedAt: number;
}

async function fetchUpstream<T>(url: string, axiosConfig?: AxiosRequestConfig, beforeFetch?: () => Promise<void>): Promise<T> {
  await beforeFetch?.();
  const resp = await axios.get<T>(url, {
    timeout: config.upstreamTimeoutMs,
    ...axiosConfig,
    headers: {
      'User-Agent': 'MacroMonitor/0.1 (proxy)',
      Accept: 'application/json',
      ...(axiosConfig?.headers ?? {}),
    },
  });
  return resp.data;
}

export async function proxyFetch<T>({
  key,
  url,
  ttlSec,
  axiosConfig,
  beforeFetch,
}: ProxyFetchOptions): Promise<ProxyResult<T>> {
  const cached = cache.lookup<T>(key);

  if (cached.status === 'hit' && cached.data !== null) {
    return { data: cached.data, source: 'cache', fetchedAt: Date.now() };
  }

  if (cached.status === 'stale' && cached.data !== null) {
    if (!inflight.has(key)) {
      const p = fetchUpstream<T>(url, axiosConfig, beforeFetch)
        .then((data) => {
          cache.set(key, data, ttlSec, config.cache.staleGrace);
          return data;
        })
        .catch((err) => {
          console.warn(`[proxy] background refresh failed for ${key}:`, err.message);
          return null;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
    }
    return { data: cached.data, source: 'stale', fetchedAt: Date.now() };
  }

  if (inflight.has(key)) {
    const data = (await inflight.get(key)) as T;
    return { data, source: 'fresh', fetchedAt: Date.now() };
  }

  const p = fetchUpstream<T>(url, axiosConfig, beforeFetch)
    .then((data) => {
      cache.set(key, data, ttlSec, config.cache.staleGrace);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);

  try {
    const data = await p;
    return { data, source: 'fresh', fetchedAt: Date.now() };
  } catch (err) {
    const fallback = cache.peek<T>(key);
    if (fallback !== null) {
      return { data: fallback, source: 'stale', fetchedAt: Date.now() };
    }
    throw err;
  }
}
