import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';

const router = Router();

const VALID_INTERVALS = new Set([
  '1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h',
  '1d', '5d', '1wk', '1mo', '3mo',
]);
const VALID_RANGES = new Set([
  '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max',
]);

interface YahooChartResponse {
  chart: {
    result?: Array<{
      meta: Record<string, unknown>;
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: (number | null)[]; open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[] }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

router.get('/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { symbol } = req.params;
    const interval = typeof req.query.interval === 'string' && VALID_INTERVALS.has(req.query.interval)
      ? req.query.interval
      : '1d';
    const range = typeof req.query.range === 'string' && VALID_RANGES.has(req.query.range)
      ? req.query.range
      : '1mo';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div,splits`;
    const cacheKey = `yahoo:${symbol}:${interval}:${range}`;

    const result = await proxyFetch<YahooChartResponse>({
      key: cacheKey,
      url,
      ttlSec: config.cache.price,
    });

    res.setHeader('X-Cache', result.source);
    res.json({
      symbol,
      interval,
      range,
      chart: result.data.chart,
      source: result.source,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
