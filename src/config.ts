import dotenv from 'dotenv';

dotenv.config();

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  corsOrigins: (process.env.CORS_ORIGIN ?? '*').split(',').map((origin) => origin.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'dev',

  fredApiKey: process.env.FRED_API_KEY ?? '',

  // translate English RSS headlines to Korean (free Google endpoint, cached)
  translateNews: (process.env.TRANSLATE_NEWS ?? 'true') !== 'false',

  // admin token gating manual/debug endpoints (e.g. POST /api/push/run).
  // empty + production = those endpoints are disabled.
  adminToken: process.env.ADMIN_TOKEN ?? '',

  // Personal API authentication. Keep this server-side; never expose it in Expo.
  personalApiToken: process.env.PERSONAL_API_TOKEN ?? '',
  // Per-device mobile sessions are signed by this server-only secret. A shared
  // personalApiToken remains available for private workers/admin tooling.
  personalSessionSecret: process.env.PERSONAL_SESSION_SECRET ?? '',
  // Explicit opt-in for local development only. This never enables in production.
  personalApiAllowLocal: (process.env.PERSONAL_API_ALLOW_LOCAL ?? 'false') === 'true',
  personalStorePath: process.env.PERSONAL_STORE_PATH ?? './data/personal-store.json',
  // Optional Supabase PostgREST persistence. The service-role key is server-only.
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  personalStoreBackend: (process.env.PERSONAL_STORE_BACKEND ?? 'json') as 'json' | 'supabase',
  briefing: {
    enabled: (process.env.BRIEFING_ENABLED ?? 'false') === 'true',
    cron: process.env.BRIEFING_CRON ?? '30 21 * * 0-4',
    ownerId: process.env.BRIEFING_OWNER_ID ?? 'default',
    internalSecret: process.env.BRIEFING_INTERNAL_SECRET ?? '',
  },

  // simple per-IP rate limit (requests per minute); 0 disables
  // A mobile dashboard loads several independent cards at once. Keep a
  // per-IP guard for the public proxy, but allow a normal refresh/navigation
  // session without producing false 429 responses.
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 300),

  cache: {
    price: num('CACHE_TTL_PRICE', 60),
    macro: num('CACHE_TTL_MACRO', 3600),
    onchain: num('CACHE_TTL_ONCHAIN', 300),
    stable: num('CACHE_TTL_STABLE', 900), // CoinGecko stablecoin charts (rate-limit hardening)
    rwa: num('CACHE_TTL_RWA', 1800), // DefiLlama RWA protocols/history
    etf: num('CACHE_TTL_ETF', 1800), // Farside BTC ETF HTML
    staleGrace: num('CACHE_STALE_GRACE', 86400),
  },

  upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 10000),

  // ── Phase 13: push notifications / cron ──────────────────────────────
  push: {
    enabled: (process.env.PUSH_ENABLED ?? 'true') !== 'false',
    // node-cron expression — default every 15 minutes
    cron: process.env.ALERT_CRON ?? '*/15 * * * *',
    // self base URL the cron uses to read its own API
    selfBaseUrl: process.env.SELF_BASE_URL ?? `http://localhost:${num('PORT', 4000)}`,
    // file where registered Expo push tokens are persisted
    tokenStorePath: process.env.PUSH_TOKEN_STORE ?? './data/push-tokens.json',
    alertStatePath: process.env.ALERT_STATE_STORE ?? './data/alert-state.json',
  },
} as const;

export const hasFredKey = (): boolean => config.fredApiKey.length > 0;
