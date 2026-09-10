import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { proxyFetch } from '../services/proxyFetch';
import axios from 'axios';

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

type QuoteResponse = {
  symbol: string;
  interval: string;
  range: string;
  chart: YahooChartResponse['chart'];
  source: string;
};

function isProviderUnavailable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status ?? 0;
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status === 451 || status >= 500;
}

async function fetchQuote(symbol: string, interval: string, range: string): Promise<{ chart: YahooChartResponse['chart']; source: string }> {
  let lastError: unknown;
  // Yahoo serves the same public chart API from two hosts. Render/free-tier
  // egress can intermittently receive a 404 or 429 from one host, so retry the
  // second host before reporting a symbol failure. No fabricated quote is used.
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div,splits`;
    const cacheKey = `yahoo:${host}:${symbol}:${interval}:${range}`;
    try {
      const result = await proxyFetch<YahooChartResponse>({ key: cacheKey, url, ttlSec: config.cache.price });
      return { chart: result.data.chart, source: result.source };
    } catch (error) {
      lastError = error;
      if (!isProviderUnavailable(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Yahoo 시세 제공자가 응답하지 않았습니다.');
}

function parseSymbols(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((symbol) => symbol.trim()).filter(Boolean))].slice(0, 30);
}

async function respondForSymbol(symbol: string, interval: string, range: string): Promise<QuoteResponse> {
  const result = await fetchQuote(symbol, interval, range);
  return { symbol, interval, range, chart: result.chart, source: result.source };
}

// Batch is the preferred mobile path: one client request and a bounded,
// server-side sequence avoids a burst of upstream calls on every dashboard.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbols = parseSymbols(req.query.symbols);
    if (!symbols.length) {
      res.status(400).json({ error: 'invalid_request', message: 'symbols query is required' });
      return;
    }
    const interval = typeof req.query.interval === 'string' && VALID_INTERVALS.has(req.query.interval) ? req.query.interval : '1d';
    const range = typeof req.query.range === 'string' && VALID_RANGES.has(req.query.range) ? req.query.range : '1d';
    const items: QuoteResponse[] = [];
    const failures: Array<{ symbol: string; message: string }> = [];
    // Two concurrent upstream requests keep a mobile refresh responsive while
    // avoiding a burst that triggers Yahoo's anonymous-IP throttling.
    let cursor = 0;
    const worker = async () => {
      while (cursor < symbols.length) {
        const index = cursor++;
        const symbol = symbols[index];
        try {
          items[index] = await respondForSymbol(symbol, interval, range);
        } catch (error) {
          failures.push({ symbol, message: error instanceof Error ? error.message : 'quote unavailable' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, symbols.length) }, worker));
    items.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
    res.json({ items, failures, requested: symbols.length, succeeded: items.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { symbol } = req.params;
    const interval = typeof req.query.interval === 'string' && VALID_INTERVALS.has(req.query.interval)
      ? req.query.interval
      : '1d';
    const range = typeof req.query.range === 'string' && VALID_RANGES.has(req.query.range)
      ? req.query.range
      : '1mo';

    const result = await respondForSymbol(symbol, interval, range);
    res.setHeader('X-Cache', result.source);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
