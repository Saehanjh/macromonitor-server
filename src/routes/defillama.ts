import { Router } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { HttpError } from '../middleware/errorHandler';

const router = Router();

const STABLECOINS_BASE = 'https://stablecoins.llama.fi';
const TVL_BASE = 'https://api.llama.fi';

router.get('/stablecoins', async (req, res, next) => {
  try {
    const includePrices = req.query.includePrices === 'true' ? 'true' : 'false';
    const url = `${STABLECOINS_BASE}/stablecoins?includePrices=${includePrices}`;
    const result = await proxyFetch<{ peggedAssets: unknown[] }>({
      key: `dl:stablecoins:${includePrices}`,
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/stablecoincharts/all', async (_req, res, next) => {
  try {
    const url = `${STABLECOINS_BASE}/stablecoincharts/all`;
    const result = await proxyFetch<unknown>({
      key: 'dl:stablecoincharts:all',
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/tvl/:protocol', async (req, res, next) => {
  try {
    const { protocol } = req.params;
    if (!protocol) throw new HttpError(400, 'protocol param required');
    const url = `${TVL_BASE}/tvl/${encodeURIComponent(protocol)}`;
    const result = await proxyFetch<number | unknown>({
      key: `dl:tvl:${protocol}`,
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ protocol, tvl: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/protocols', async (_req, res, next) => {
  try {
    const url = `${TVL_BASE}/protocols`;
    const result = await proxyFetch<unknown[]>({
      key: 'dl:protocols',
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

export default router;
