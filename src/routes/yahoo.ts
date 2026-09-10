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

const YAHOO_HEADERS = {
  // Yahoo sometimes serves an Edge 429 to generic proxy user agents. A normal
  // browser-compatible accept profile is both supported by the public chart
  // endpoint and materially more reliable on shared cloud egress addresses.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

let yahooQueue: Promise<void> = Promise.resolve();
let nextYahooRequestAt = 0;
let yahooCooldownUntil = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Render users share an outbound IP. Serialize only cache-miss Yahoo calls so
 * ten dashboard tickers do not become a simultaneous anonymous-provider burst.
 */
function reserveYahooRequest(): Promise<void> {
  const task = yahooQueue.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, nextYahooRequestAt - now, yahooCooldownUntil - now);
    if (delay) await sleep(delay);
    nextYahooRequestAt = Date.now() + config.yahooMinIntervalMs;
  });
  // Keep the queue usable after any earlier provider failure.
  yahooQueue = task.catch(() => undefined);
  return task;
}

function noteYahooFailure(error: unknown): void {
  if (axios.isAxiosError(error) && error.response?.status === 429) {
    yahooCooldownUntil = Math.max(yahooCooldownUntil, Date.now() + config.yahooCooldownSec * 1000);
  }
}

function isRateLimited(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

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
    // The two Yahoo hostnames contain the same data. Sharing a cache key means
    // a successful retry is available regardless of which host served it.
    const cacheKey = `yahoo:${symbol}:${interval}:${range}`;
    try {
      const result = await proxyFetch<YahooChartResponse>({
        key: cacheKey,
        url,
        ttlSec: config.cache.price,
        axiosConfig: { headers: YAHOO_HEADERS },
        beforeFetch: reserveYahooRequest,
      });
      return { chart: result.data.chart, source: result.source };
    } catch (error) {
      lastError = error;
      noteYahooFailure(error);
      // A 429 applies to the shared provider/IP, not merely query1 or query2.
      // Do not turn one provider limit into another ten failed requests.
      if (isRateLimited(error)) break;
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
    // A single upstream worker is intentional. The public Yahoo API limits
    // shared Render egress addresses; cache hits still return immediately.
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
    await Promise.all(Array.from({ length: Math.min(1, symbols.length) }, worker));
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
