import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import { HttpError } from '../middleware/errorHandler';

const router = Router();
const BASE = 'https://api.coingecko.com/api/v3';

router.get('/simple/price', async (req, res, next) => {
  try {
    const ids = String(req.query.ids ?? '');
    const vs = String(req.query.vs_currencies ?? 'usd');
    if (!ids) throw new HttpError(400, 'ids query is required');

    const url = `${BASE}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true&include_market_cap=true`;
    const result = await proxyFetch<Record<string, Record<string, number>>>({
      key: `cg:price:${ids}:${vs}`,
      url,
      ttlSec: config.cache.price,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/coins/markets', async (req, res, next) => {
  try {
    const vs = String(req.query.vs_currency ?? 'usd');
    const ids = typeof req.query.ids === 'string' ? req.query.ids : '';
    const perPage = String(req.query.per_page ?? '50');
    const page = String(req.query.page ?? '1');

    const params = new URLSearchParams({
      vs_currency: vs,
      order: 'market_cap_desc',
      per_page: perPage,
      page,
      sparkline: 'false',
      price_change_percentage: '24h,7d',
    });
    if (ids) params.set('ids', ids);

    const url = `${BASE}/coins/markets?${params.toString()}`;
    const result = await proxyFetch<unknown[]>({
      key: `cg:markets:${params.toString()}`,
      url,
      ttlSec: config.cache.price,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/coins/:id/market_chart', async (req, res, next) => {
  try {
    const { id } = req.params;
    const vs = String(req.query.vs_currency ?? 'usd');
    const days = String(req.query.days ?? '30');
    const interval = typeof req.query.interval === 'string' ? req.query.interval : '';

    const params = new URLSearchParams({ vs_currency: vs, days });
    if (interval) params.set('interval', interval);

    const url = `${BASE}/coins/${encodeURIComponent(id)}/market_chart?${params.toString()}`;
    const result = await proxyFetch<{ prices: [number, number][]; market_caps: [number, number][]; total_volumes: [number, number][] }>({
      key: `cg:chart:${id}:${params.toString()}`,
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ id, ...result.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

router.get('/global', async (_req, res, next) => {
  try {
    const url = `${BASE}/global`;
    const result = await proxyFetch<{ data: Record<string, unknown> }>({
      key: 'cg:global',
      url,
      ttlSec: config.cache.onchain,
    });

    res.setHeader('X-Cache', result.source);
    res.json({ data: result.data.data, source: result.source });
  } catch (err) {
    next(err);
  }
});

export default router;
