import { config } from '../config';

export function isSupabaseConfigured(): boolean {
  return config.personalStoreBackend === 'supabase' && Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

function endpoint(ownerId: string): string {
  return `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/personal_store?owner_id=eq.${encodeURIComponent(ownerId)}`;
}

function headers(): Record<string, string> {
  return { apikey: config.supabaseServiceRoleKey, Authorization: `Bearer ${config.supabaseServiceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}

/** Server-only bounded adapter. RLS must deny anon access; this key is never bundled in Expo. */
export async function readStore<T>(ownerId: string): Promise<T | null> {
  if (!isSupabaseConfigured()) return null;
  const response = await fetch(endpoint(ownerId), { headers: headers() });
  if (!response.ok) throw new Error(`Supabase read failed (${response.status})`);
  const rows = await response.json() as Array<{ payload: T }>;
  return rows[0]?.payload ?? null;
}

export async function writeStore<T>(ownerId: string, payload: T): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/personal_store`, {
    method: 'POST', headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ owner_id: ownerId, payload, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Supabase write failed (${response.status})`);
}
