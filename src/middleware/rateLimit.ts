import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { INTERNAL_SECRET, INTERNAL_HEADER } from '../services/internalAuth';

// Minimal in-memory fixed-window rate limiter (per IP, per minute).
// Good enough to stop casual relay abuse of the public proxy without
// adding a dependency; swap for a store-backed limiter behind a LB.

const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; windowStart: number }>();

// periodic cleanup so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) {
    if (now - rec.windowStart > WINDOW_MS * 2) hits.delete(ip);
  }
}, WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const max = config.rateLimitPerMin;
  if (max <= 0 || req.path === '/health') {
    next();
    return;
  }
  // this process's own cron self-calls carry the per-boot secret — exempt them
  // so external traffic can never starve the alert evaluators
  if (req.header(INTERNAL_HEADER) === INTERNAL_SECRET) {
    next();
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now - rec.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }

  rec.count += 1;
  if (rec.count > max) {
    res.setHeader('Retry-After', Math.ceil((rec.windowStart + WINDOW_MS - now) / 1000));
    res.status(429).json({ error: 'rate_limited', message: 'Too many requests' });
    return;
  }
  next();
}
