import { Router } from 'express';
import { getMarketBriefing } from '../services/marketBriefing';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const briefing = await getMarketBriefing();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(briefing);
  } catch (error) {
    next(error);
  }
});

export default router;
