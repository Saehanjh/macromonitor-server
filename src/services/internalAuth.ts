import crypto from 'crypto';

// Per-boot random secret identifying this process's own internal HTTP calls
// (the alert cron reads the public API via SELF_BASE_URL). Requests carrying
// it bypass the per-IP rate limiter so external traffic can never starve the
// alert evaluators. Never logged, never persisted, unknowable from outside.
export const INTERNAL_SECRET = crypto.randomBytes(16).toString('hex');
export const INTERNAL_HEADER = 'x-internal-secret';
