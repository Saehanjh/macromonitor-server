type Entry<T> = {
  data: T;
  freshUntil: number;
  staleUntil: number;
};

const store = new Map<string, Entry<unknown>>();

export type CacheStatus = 'hit' | 'stale' | 'miss';

export interface CacheLookup<T> {
  status: CacheStatus;
  data: T | null;
}

export function lookup<T>(key: string): CacheLookup<T> {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry) return { status: 'miss', data: null };
  const now = Date.now();
  if (now < entry.freshUntil) return { status: 'hit', data: entry.data };
  if (now < entry.staleUntil) return { status: 'stale', data: entry.data };
  store.delete(key);
  return { status: 'miss', data: null };
}

export function set<T>(key: string, data: T, ttlSec: number, staleGraceSec: number): void {
  const now = Date.now();
  store.set(key, {
    data,
    freshUntil: now + ttlSec * 1000,
    staleUntil: now + (ttlSec + staleGraceSec) * 1000,
  });
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
