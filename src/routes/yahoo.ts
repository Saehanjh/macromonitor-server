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

function isRateLimited(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

/**
 * Yahoo's public chart endpoint occasionally rate-limits an entire Render
 * instance. Stooq is a delayed, keyless fallback for the same display use
 * case. It is deliberately marked `fallback` so the app never presents it as
 * an exchange real-time quote.
 */
async function fetchStooq(symbol: string): Promise<YahooChartResponse> {
  const normalized = symbol.toLowerCase().replace(/\.ks$/i, '.kr');
  const response = await axios.get<string>(
    `https://stooq.com/q/l/?s=${encodeURIComponent(normalized)}&f=sd2t2ohlcv&h&e=csv`,
    { timeout: config.upstreamTimeoutMs, headers: { Accept: 'text/csv' } },
  );
  const line = response.data.trim().split(/\r?\n/).find((candidate) => candidate && !/^Symbol,Date/i.test(candidate));
  if (!line) throw new Error('Stooq returned no quote row');
  const fields = line.split(',').map((field) => field.trim());
  const [, date, time, open, high, low, close] = fields;
  const price = Number(close);
  const timestamp = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
    throw new Error('Stooq returned an invalid quote');
  }
  const previous = Number(open);
  const currency = normalized.endsWith('.kr') ? 'KRW' : 'USD';
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          previousClose: Number.isFinite(previous) && previous > 0 ? previous : undefined,
          regularMarketTime: Math.floor(timestamp / 1000),
          currency,
        },
      }],
      error: null,
    },
  };
}

async function fetchQuote(symbol: string, interval: string, range: string): Promise<{ chart: YahooChartResponse['chart']; source: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div,splits`;
  const cacheKey = `yahoo:${symbol}:${interval}:${range}`;
  try {
    const result = await proxyFetch<YahooChartResponse>({ key: cacheKey, url, ttlSec: config.cache.price });
    return { chart: result.data.chart, source: result.source };
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    const fallback = await fetchStooq(symbol);
    return { chart: fallback.chart, source: 'fallback' };
  }
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
    for (const symbol of symbols) {
      try {
        items.push(await respondForSymbol(symbol, interval, range));
      } catch (error) {
        failures.push({ symbol, message: error instanceof Error ? error.message : 'quote unavailable' });
      }
    }
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
