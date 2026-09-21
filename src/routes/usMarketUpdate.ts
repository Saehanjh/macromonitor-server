import { Router } from 'express';
import { getUSMarketUpdate } from '../services/usMarketUpdate';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const forceRefresh = String(req.query.refresh ?? '') === '1' || String(req.query.refresh ?? '') === 'true';
    const report = await getUSMarketUpdate(forceRefresh);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Report-Source', report.source);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

export default router;

