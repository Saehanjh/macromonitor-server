type Entry<T> = {
  data: T;
  /** Original upstream success time. It must not be replaced by a cache-hit time. */
  fetchedAt: number;
  freshUntil: number;
  staleUntil: number;
};

const store = new Map<string, Entry<unknown>>();

export type CacheStatus = 'hit' | 'stale' | 'miss';

export interface CacheLookup<T> {
  status: CacheStatus;
  data: T | null;
  fetchedAt: number | null;
}

export function lookup<T>(key: string): CacheLookup<T> {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return { status: 'miss', data: null, fetchedAt: null };
  const now = Date.now();
  if (now < entry.freshUntil) return { status: 'hit', data: entry.data, fetchedAt: entry.fetchedAt };
  if (now < entry.staleUntil) return { status: 'stale', data: entry.data, fetchedAt: entry.fetchedAt };
  store.delete(key);
  return { status: 'miss', data: null, fetchedAt: null };
}

export function set<T>(key: string, data: T, ttlSec: number, staleGraceSec: number): void {
  const now = Date.now();
  store.set(key, {
    data,
    fetchedAt: now,
    freshUntil: now + ttlSec * 1000,
    staleUntil: now + (ttlSec + staleGraceSec) * 1000,
  });
}

export function peekWithMetadata<T>(key: string): { data: T; fetchedAt: number } | null {
  const entry = store.get(key) as Entry<T> | undefined;
  return entry ? { data: entry.data, fetchedAt: entry.fetchedAt } : null;
}

export function peek<T>(key: string): T | null {
  const entry = store.get(key) as Entry<T> | undefined;
  return entry ? entry.data : null;
}

export function size(): number {
  return store.size;
}

export function clear(): void {
  store.clear();
}
