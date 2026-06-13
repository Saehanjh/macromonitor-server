import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { addToken, removeToken, listTokens, snapshotAlertState } from '../services/pushStore';
import { runAlertCycle } from '../services/cron';

const router = Router();

// Manual-trigger endpoints can fan out pushes to every device — gate them.
// ADMIN_TOKEN set → require matching x-admin-token header.
// ADMIN_TOKEN unset → allow in development only, 403 in production.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (config.adminToken) {
    if (req.header('x-admin-token') === config.adminToken) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized', message: 'x-admin-token required' });
    return;
  }
  if (config.nodeEnv === 'production') {
    res.status(403).json({ error: 'forbidden', message: 'set ADMIN_TOKEN to enable this endpoint' });
    return;
  }
  next();
}

// POST /api/push/register { token }
router.post('/register', (req: Request, res: Response) => {
  const token = String(req.body?.token ?? '');
  if (!token.startsWith('ExponentPushToken')) {
    res.status(400).json({ error: 'invalid_token', message: 'Expo push token required' });
    return;
  }
  addToken(token);
  res.json({ ok: true, count: listTokens().length });
});

// POST /api/push/unregister { token }
router.post('/unregister', (req: Request, res: Response) => {
  removeToken(String(req.body?.token ?? ''));
  res.json({ ok: true, count: listTokens().length });
});

// GET /api/push/status — current alert states + registered device count
router.get('/status', (_req: Request, res: Response) => {
  res.json({ devices: listTokens().length, alerts: snapshotAlertState() });
});

// POST /api/push/run — manually trigger an evaluation cycle (debug/testing)
router.post('/run', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runAlertCycle();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
