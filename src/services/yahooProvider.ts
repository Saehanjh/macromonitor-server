import axios from 'axios';
import { config } from '../config';
import { proxyFetch, ProxyResult } from './proxyFetch';

// Yahoo's public chart endpoint is shared by quotes and the macro dashboard.
// Keep its protection here so a cold dashboard cannot bypass the quote route's
// pacing and turn one screen load into a burst of provider failures.
export const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

let queue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;
let cooldownUntil = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class YahooRateLimitedError extends Error {
  constructor() {
    super('Yahoo 시세 제공자가 요청을 잠시 제한했습니다. 잠시 후 다시 시도해 주세요.');
    this.name = 'YahooRateLimitedError';
  }
}

export function reserveYahooRequest(): Promise<void> {
  const task = queue.then(async () => {
    const now = Date.now();
    if (now < cooldownUntil) throw new YahooRateLimitedError();
    const wait = Math.max(0, nextRequestAt - now);
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + config.yahooMinIntervalMs;
  });
  queue = task.catch(() => undefined);
  return task;
}

export function noteYahooFailure(error: unknown): void {
  if (axios.isAxiosError(error) && error.response?.status === 429) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + config.yahooCooldownSec * 1000);
  }
}

export function isYahooRateLimited(error: unknown): boolean {
  return error instanceof YahooRateLimitedError || (axios.isAxiosError(error) && error.response?.status === 429);
}

/**
 * Fetch one public Yahoo chart with the same pacing, browser headers and
 * provider cooldown used by the quote endpoints. Cache hits never queue.
 */
export async function fetchYahooChart<T>(
  symbol: string,
  range: string,
  interval: string,
  ttlSec = config.cache.price,
): Promise<ProxyResult<T>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=${interval}&range=${range}&includePrePost=false`;
  try {
    return await proxyFetch<T>({
      key: `yahoo:${symbol}:${interval}:${range}`,
      url,
      ttlSec,
      axiosConfig: { headers: YAHOO_HEADERS },
      beforeFetch: reserveYahooRequest,
    });
  } catch (error) {
    noteYahooFailure(error);
    throw error;
  }
}
