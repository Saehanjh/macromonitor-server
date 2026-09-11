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

type QuoteSession = 'regular' | 'extended';

export type QuoteSummary = {
  price: number;
  currency: 'USD' | 'KRW' | 'JPY';
  changePercent: number | null;
  asOf: string;
  session: QuoteSession;
  /** What the percentage is compared with. */
  changeBasis: 'previous_close' | 'regular_close';
};

export type QuoteResponse = {
  symbol: string;
  interval: string;
  range: string;
  chart: YahooChartResponse['chart'];
  source: string;
  /** Server time of the original successful upstream response, not this cache hit. */
  fetchedAt: string;
  cacheAgeSec: number;
  quote: QuoteSummary;
};

type InstrumentMarket = 'US' | 'KR';
type ChartPeriod = 'daily' | 'weekly' | 'monthly';

const PUBLIC_SYMBOL = /^[A-Z0-9.^=\-]{1,24}$/;
const HISTORY_PERIODS: Record<ChartPeriod, { interval: string; range: string }> = {
  daily: { interval: '1d', range: '3mo' },
  weekly: { interval: '1wk', range: '1y' },
  monthly: { interval: '1mo', range: '5y' },
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

class YahooRateLimitedError extends Error {
  constructor() {
    super('Yahoo 시세 제공자가 요청을 잠시 제한했습니다. 잠시 후 다시 시도해 주세요.');
    this.name = 'YahooRateLimitedError';
  }
}

/**
 * Render users share an outbound IP. Serialize only cache-miss Yahoo calls so
 * ten dashboard tickers do not become a simultaneous anonymous-provider burst.
 */
function reserveYahooRequest(): Promise<void> {
  const task = yahooQueue.then(async () => {
    const now = Date.now();
    // A known provider cooldown is a circuit breaker, not a reason to make
    // every request wait for two minutes and then time out on the phone.
    if (now < yahooCooldownUntil) throw new YahooRateLimitedError();
    const delay = Math.max(0, nextYahooRequestAt - now);
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
  return error instanceof YahooRateLimitedError || (axios.isAxiosError(error) && error.response?.status === 429);
}

function isProviderUnavailable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status ?? 0;
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status === 451 || status >= 500;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function lastValidBar(chart: YahooChartResponse['chart']): { price: number; timestamp: number } | null {
  const result = chart.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result?.timestamp ?? [];
  for (let index = Math.min(closes.length, timestamps.length) - 1; index >= 0; index -= 1) {
    const price = closes[index];
    const timestamp = timestamps[index];
    if (finite(price) && price > 0 && finite(timestamp) && timestamp > 0) {
      return { price, timestamp };
    }
  }
  return null;
}

/**
 * Build an explicit quote contract from Yahoo's chart response. The original
 * app recomputed a percentage from a different close field and treated every
 * chart meta price as live. Keeping the provider value and the market session
 * together makes the displayed number auditable.
 */
export function summarizeQuote(chart: YahooChartResponse['chart']): QuoteSummary {
  const meta = chart.result?.[0]?.meta ?? {};
  const regularPrice = meta.regularMarketPrice;
  const regularTime = meta.regularMarketTime;
  const currency = meta.currency;
  if (!finite(regularPrice) || regularPrice <= 0 || !finite(regularTime) || regularTime <= 0 || (currency !== 'USD' && currency !== 'KRW' && currency !== 'JPY')) {
    throw new Error('시세 제공자가 완전한 가격 기준정보를 반환하지 않았습니다.');
  }

  const bar = lastValidBar(chart);
  // For an intraday request with includePrePost=true, a bar after the regular
  // timestamp is a real provider-supplied extended-hours value. Daily bars
  // never satisfy this condition, so they retain the official regular price.
  const isExtended = !!bar && bar.timestamp > regularTime + 60;
  const price = isExtended ? bar!.price : regularPrice;
  const asOfSeconds = isExtended ? bar!.timestamp : regularTime;
  const previousClose = finite(meta.previousClose) && meta.previousClose > 0
    ? meta.previousClose
    : finite(meta.chartPreviousClose) && meta.chartPreviousClose > 0
      ? meta.chartPreviousClose
      : null;
  const regularPercent = meta.regularMarketChangePercent;
  const extendedReference = regularPrice;
  const changePercent = isExtended
    ? (extendedReference > 0 ? (price / extendedReference - 1) * 100 : null)
    : finite(regularPercent)
      ? regularPercent
      : previousClose ? (price / previousClose - 1) * 100 : null;

  return {
    price,
    currency,
    changePercent,
    asOf: new Date(asOfSeconds * 1000).toISOString(),
    session: isExtended ? 'extended' : 'regular',
    changeBasis: isExtended ? 'regular_close' : 'previous_close',
  };
}

async function fetchQuote(symbol: string, interval: string, range: string): Promise<{ chart: YahooChartResponse['chart']; source: string; fetchedAt: number }> {
  let lastError: unknown;
  // Yahoo serves the same public chart API from two hosts. Render/free-tier
  // egress can intermittently receive a 404 or 429 from one host, so retry the
  // second host before reporting a symbol failure. No fabricated quote is used.
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true&events=div,splits`;
    // The two Yahoo hostnames contain the same data. Sharing a cache key means
    // a successful retry is available regardless of which host served it.
    const cacheKey = `yahoo:${symbol}:${interval}:${range}`;
    try {
      const result = await proxyFetch<YahooChartResponse>({
        key: cacheKey,
        url,
        ttlSec: config.quoteCacheTtlSec,
        staleGraceSec: config.quoteStaleGraceSec,
        axiosConfig: { headers: YAHOO_HEADERS },
        beforeFetch: reserveYahooRequest,
      });
      return { chart: result.data.chart, source: result.source, fetchedAt: result.fetchedAt };
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

export async function getYahooQuote(symbol: string, interval = '1d', range = '1d'): Promise<QuoteResponse> {
  const result = await fetchQuote(symbol, interval, range);
  const now = Date.now();
  return {
    symbol,
    interval,
    range,
    chart: result.chart,
    source: result.source,
    fetchedAt: new Date(result.fetchedAt).toISOString(),
    cacheAgeSec: Math.max(0, Math.floor((now - result.fetchedAt) / 1000)),
    quote: summarizeQuote(result.chart),
  };
}

export function instrumentCandidates(rawSymbol: string, market: InstrumentMarket): string[] {
  const normalized = rawSymbol.trim().toUpperCase();
  if (!PUBLIC_SYMBOL.test(normalized)) return [];
  if (market === 'US') return [normalized];
  if (normalized.endsWith('.KS') || normalized.endsWith('.KQ')) return [normalized];
  if (!/^\d{4,6}$/.test(normalized)) return [];
  const code = normalized.padStart(6, '0');
  return [`${code}.KS`, `${code}.KQ`];
}

export function historicalPoints(chart: YahooChartResponse['chart']): Array<{ t: number; close: number }> {
  const result = chart.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  return timestamps.flatMap((timestamp, index) => {
    const close = closes[index];
    return finite(timestamp) && timestamp > 0 && finite(close) && close > 0 ? [{ t: timestamp, close }] : [];
  });
}

async function resolveInstrument(rawSymbol: string, market: InstrumentMarket, interval: string, range: string): Promise<QuoteResponse> {
  const candidates = instrumentCandidates(rawSymbol, market);
  if (!candidates.length) throw new Error('지원하지 않는 종목 코드입니다.');
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await getYahooQuote(candidate, interval, range);
    } catch (error) {
      lastError = error;
      if (isRateLimited(error)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('종목 정보를 확인할 수 없습니다.');
}

function readMarket(value: unknown): InstrumentMarket | null {
  return value === 'US' || value === 'KR' ? value : null;
}

router.get('/instrument/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = readMarket(req.query.market);
    if (!market || !instrumentCandidates(req.params.symbol, market).length) {
      res.status(400).json({ error: 'invalid_request', message: '유효한 종목 코드와 market(US/KR)이 필요합니다.' });
      return;
    }
    const result = await resolveInstrument(req.params.symbol, market, '1d', '5d');
    const meta = result.chart.result?.[0]?.meta ?? {};
    const longName = typeof meta.longName === 'string' ? meta.longName.trim() : '';
    const shortName = typeof meta.shortName === 'string' ? meta.shortName.trim() : '';
    const name = longName || shortName;
    if (!name) {
      res.status(404).json({ error: 'instrument_name_unavailable', message: '시세 제공자에서 기업명을 확인하지 못했습니다.' });
      return;
    }
    res.json({
      symbol: req.params.symbol.trim().toUpperCase(), providerSymbol: result.symbol, market, name,
      longName: longName || null, shortName: shortName || null,
      exchangeName: typeof meta.fullExchangeName === 'string' ? meta.fullExchangeName : (typeof meta.exchangeName === 'string' ? meta.exchangeName : null),
      currency: meta.currency === 'USD' || meta.currency === 'KRW' ? meta.currency : null,
      source: result.source, fetchedAt: result.fetchedAt,
    });
  } catch (error) { next(error); }
});

router.get('/history/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const market = readMarket(req.query.market);
    const period = typeof req.query.period === 'string' && req.query.period in HISTORY_PERIODS ? req.query.period as ChartPeriod : null;
    if (!market || !period || !instrumentCandidates(req.params.symbol, market).length) {
      res.status(400).json({ error: 'invalid_request', message: 'market(US/KR)과 period(daily/weekly/monthly)가 필요합니다.' });
      return;
    }
    const settings = HISTORY_PERIODS[period];
    const result = await resolveInstrument(req.params.symbol, market, settings.interval, settings.range);
    const points = historicalPoints(result.chart);
    if (points.length < 2) {
      res.status(404).json({ error: 'history_unavailable', message: '표시할 가격 이력이 충분하지 않습니다.' });
      return;
    }
    res.json({
      symbol: req.params.symbol.trim().toUpperCase(), providerSymbol: result.symbol, market, period,
      interval: settings.interval, range: settings.range, currency: result.quote.currency,
      source: result.source, fetchedAt: result.fetchedAt,
      asOf: new Date(points[points.length - 1].t * 1000).toISOString(), points,
    });
  } catch (error) { next(error); }
});

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
    let providerRateLimited = false;
    const worker = async () => {
      while (cursor < symbols.length) {
        const index = cursor++;
        const symbol = symbols[index];
        if (providerRateLimited) {
          failures.push({ symbol, message: '시세 제공자가 요청을 잠시 제한했습니다. 잠시 후 다시 시도해 주세요.' });
          continue;
        }
        try {
          items[index] = await getYahooQuote(symbol, interval, range);
        } catch (error) {
          if (isRateLimited(error)) providerRateLimited = true;
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

    const result = await getYahooQuote(symbol, interval, range);
    res.setHeader('X-Cache', result.source);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
