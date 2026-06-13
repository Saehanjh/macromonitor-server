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
  logLevel: process.env.LOG_LEVEL ?? 'dev',

  fredApiKey: process.env.FRED_API_KEY ?? '',

  // admin token gating manual/debug endpoints (e.g. POST /api/push/run).
  // empty + production = those endpoints are disabled.
  adminToken: process.env.ADMIN_TOKEN ?? '',

  // simple per-IP rate limit (requests per minute); 0 disables
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 120),

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
