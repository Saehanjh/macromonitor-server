import { getMarketBriefing, MarketBriefing, MarketIndicator } from './marketBriefing';
import { getYahooQuote } from '../routes/yahoo';
import { fetchLatestNews, NewsItem } from '../routes/news';
import * as cache from './cache';

const CACHE_KEY = 'us-market-update:latest';
const TTL_SEC = 15 * 60;
const STALE_GRACE_SEC = 60 * 60;

export interface USMarketUpdate {
  reportDate: string;
  generatedAt: string;
  source: 'fresh' | 'cache' | 'stale';
  coverage: MarketBriefing['coverage'];
  title: string;
  text: string;
  indicators: MarketBriefing['indicators'];
  dailyView: MarketBriefing['dailyView'];
  macroDrivers: MarketBriefing['macroDrivers'];
  scenarios: MarketBriefing['scenarios'];
  risk: MarketBriefing['risk'];
  sources: Array<{ provider: MarketIndicator['provider']; asOf: string | null; fetchedAt: string | null }>;
  equities: EquitySnapshot[];
  headlines: NewsItem[];
}

export interface EquitySnapshot {
  symbol: 'SPY' | 'QQQ' | 'DIA'; label: string; value: number | null; changePercent: number | null;
  asOf: string | null; fetchedAt: string | null; provider: 'Yahoo Finance';
  source: 'fresh' | 'cache' | 'stale' | 'unavailable'; message?: string;
}

export function buildUSMarketUpdate(briefing: MarketBriefing, equities: EquitySnapshot[], headlines: NewsItem[], now = new Date()): USMarketUpdate {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const reportDate = `${part('year')}-${part('month')}-${part('day')}`;
  return {
    reportDate, generatedAt: now.toISOString(), source: 'fresh', coverage: briefing.coverage,
    title: `US Market Update · ${reportDate}`, text: buildText(briefing), indicators: briefing.indicators,
    dailyView: briefing.dailyView, macroDrivers: briefing.macroDrivers, scenarios: briefing.scenarios,
    risk: briefing.risk,
    sources: briefing.indicators.map(({ provider, asOf, fetchedAt }) => ({ provider, asOf, fetchedAt })),
    equities, headlines,
  };
}

let refreshInFlight: Promise<USMarketUpdate> | null = null;

function formatIndicator(indicator: MarketIndicator): string {
  if (indicator.value == null) return `${indicator.label}: 확인 불가`;
  const value = indicator.unit === 'USD'
    ? `$${indicator.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : indicator.unit === '%'
      ? `${indicator.value.toFixed(2)}%`
      : indicator.unit === 'KRW/USD'
        ? indicator.value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
        : indicator.value.toFixed(2);
  const change = indicator.changePercent == null ? '' : ` (${indicator.changePercent >= 0 ? '+' : ''}${indicator.changePercent.toFixed(2)}%)`;
  return `${indicator.label}: ${value}${change}`;
}

function buildText(briefing: MarketBriefing): string {
  const lines = [
    `시장 상태: ${briefing.dailyView.headline}`,
    briefing.dailyView.interpretation,
    `주요 지표: ${briefing.indicators.map(formatIndicator).join(' · ')}`,
  ];
  if (briefing.macroDrivers.length) lines.push(`매크로 동인: ${briefing.macroDrivers.map((item) => item.text).join(' ')}`);
  if (briefing.risk.score != null) lines.push(`규칙 기반 위험도: ${briefing.risk.score}점 (${briefing.risk.level})`);
  return lines.join('\n\n');
}

async function fetchEquity(symbol: EquitySnapshot['symbol'], label: string): Promise<EquitySnapshot> {
  try {
    const response = await getYahooQuote(symbol, '1d', '5d');
    return { symbol, label, value: response.quote.price, changePercent: response.quote.changePercent,
      asOf: response.quote.asOf, fetchedAt: response.fetchedAt, provider: 'Yahoo Finance', source: response.source as EquitySnapshot['source'] };
  } catch {
    return { symbol, label, value: null, changePercent: null, asOf: null, fetchedAt: null,
      provider: 'Yahoo Finance', source: 'unavailable', message: `${label} 데이터를 현재 확인할 수 없습니다.` };
  }
}

async function fetchFresh(): Promise<USMarketUpdate> {
  const [briefing, equities, headlines] = await Promise.all([
    getMarketBriefing(),
    Promise.all([fetchEquity('SPY', 'S&P 500 ETF'), fetchEquity('QQQ', '나스닥 100 ETF'), fetchEquity('DIA', '다우존스 ETF')]),
    fetchLatestNews(8, 36),
  ]);
  // Never replace a useful cached report with an empty all-provider failure.
  if (briefing.coverage.status === 'failed' && equities.every((item) => item.value == null) && headlines.length === 0) {
    throw new Error('US market update providers unavailable');
  }
  const report = buildUSMarketUpdate(briefing, equities, headlines);
  cache.set(CACHE_KEY, report, TTL_SEC, STALE_GRACE_SEC);
  return report;
}

export async function getUSMarketUpdate(forceRefresh = false): Promise<USMarketUpdate> {
  if (!forceRefresh) {
    const hit = cache.lookup<USMarketUpdate>(CACHE_KEY);
    if (hit.data) return { ...hit.data, source: hit.status === 'stale' ? 'stale' : 'cache' };
  }
  if (!refreshInFlight) {
    refreshInFlight = fetchFresh().finally(() => { refreshInFlight = null; });
  }
  try {
    return await refreshInFlight;
  } catch (error) {
    const stale = cache.lookup<USMarketUpdate>(CACHE_KEY);
    if (stale.data) return { ...stale.data, source: 'stale' };
    throw error;
  }
}
