import { config, hasFredKey } from '../config';
import { getYahooQuote } from '../routes/yahoo';
import { proxyFetch, ProxyResult } from './proxyFetch';

export type MarketIndicatorKey = 'btc' | 'usdjpy' | 'usdkrw' | 'us10y' | 'us30y';
export type DataFreshness = 'fresh' | 'stale' | 'unavailable';

export interface MarketIndicator {
  key: MarketIndicatorKey;
  label: string;
  value: number | null;
  unit: 'USD' | 'JPY/USD' | 'KRW/USD' | '%';
  changePercent: number | null;
  asOf: string | null;
  fetchedAt: string | null;
  provider: 'Coinbase Exchange' | 'CoinGecko' | 'Yahoo Finance' | 'FRED';
  changeBasis?: 'rolling-24h' | 'previous-close';
  asOfBasis?: 'provider' | 'received';
  source: 'fresh' | 'cache' | 'stale' | 'unavailable';
  freshness: DataFreshness;
  message?: string;
}

export interface MarketBriefing {
  generatedAt: string;
  coverage: { status: 'complete' | 'partial' | 'failed'; requested: number; succeeded: number; failed: number };
  indicators: MarketIndicator[];
  dailyView: {
    headline: string;
    interpretation: string;
    checklist: string[];
    evidenceKeys: MarketIndicatorKey[];
  };
  macroDrivers: Array<{ tone: 'positive' | 'neutral' | 'caution'; text: string; evidenceKeys: MarketIndicatorKey[] }>;
  scenarios: Array<{ tone: 'positive' | 'neutral' | 'caution'; title: string; text: string; evidenceKeys: MarketIndicatorKey[] }>;
  risk: { score: number | null; level: 'low' | 'moderate' | 'high' | 'unavailable'; method: string; evidenceKeys: MarketIndicatorKey[] };
}

type CoinGeckoSimple = {
  bitcoin?: { usd?: number; usd_24h_change?: number; last_updated_at?: number };
};

type FredResponse = { observations?: Array<{ date?: string; value?: string }> };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const iso = (millis: number): string => new Date(millis).toISOString();

function failed(key: MarketIndicatorKey, label: string, unit: MarketIndicator['unit'], provider: MarketIndicator['provider'], error: unknown): MarketIndicator {
  const rawMessage = error instanceof Error ? error.message : '';
  const providerLimited = /\b429\b|rate.?limit|too many requests|요청.*제한/i.test(rawMessage);
  return {
    key, label, unit, provider,
    value: null, changePercent: null, asOf: null, fetchedAt: null,
    source: 'unavailable', freshness: 'unavailable',
    message: providerLimited
      ? `${label} 제공처가 요청을 잠시 제한했습니다. 잠시 후 다시 확인해 주세요.`
      : `${label} 데이터를 현재 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.`,
  };
}

function sourceStatus(source: ProxyResult<unknown>['source'], asOfMillis: number, maxObservationAgeMs: number): DataFreshness {
  return source === 'stale' || Date.now() - asOfMillis > maxObservationAgeMs ? 'stale' : 'fresh';
}

export function coinbaseBitcoin(result: ProxyResult<{ last?: string; open?: string }>): MarketIndicator {
  const price = Number(result.data.last);
  const open = Number(result.data.open);
  if (!finite(price) || price <= 0) throw new Error('Coinbase BTC 가격 누락');
  return {
    key: 'btc', label: '비트코인', value: price, unit: 'USD',
    changePercent: finite(open) && open > 0 ? (price / open - 1) * 100 : null,
    changeBasis: 'rolling-24h', asOfBasis: 'received',
    asOf: iso(result.fetchedAt), fetchedAt: iso(result.fetchedAt),
    provider: 'Coinbase Exchange', source: result.source,
    freshness: sourceStatus(result.source, result.fetchedAt, 15 * 60_000),
    message: 'Coinbase BTC-USD 24시간 통계의 마지막 거래가 / 시작가. 제공처 거래시각 미제공: 수신시각 표시.',
  };
}

async function bitcoin(): Promise<MarketIndicator> {
  try {
    const stats = await proxyFetch<{ last?: string; open?: string }>({
      key: 'morning-briefing:coinbase:btc-usd-stats',
      url: 'https://api.exchange.coinbase.com/products/BTC-USD/stats',
      ttlSec: 300, staleGraceSec: 3600,
    });
    return coinbaseBitcoin(stats);
  } catch { /* independently cached public Yahoo quote is the fallback */ }
  // Use the same guarded Yahoo path as the stock dashboard next. CoinGecko's
  // anonymous endpoint frequently returns 429 on Render's shared egress IP,
  // while BTC-USD is available from the already serialized/cached quote path.
  try {
    const response = await getYahooQuote('BTC-USD', '1d', '5d');
    return {
      key: 'btc', label: '비트코인', value: response.quote.price, unit: 'USD',
      // Yahoo chart change is versus previous close, not a rolling 24h move.
      changePercent: null,
      asOfBasis: 'provider',
      asOf: response.quote.asOf, fetchedAt: response.fetchedAt, provider: 'Yahoo Finance',
      source: response.source as MarketIndicator['source'],
      freshness: sourceStatus(response.source as ProxyResult<unknown>['source'], Date.parse(response.quote.asOf), 15 * 60_000),
      message: 'Yahoo 이전 종가 대비 등락은 24시간 변동과 달라 표시하지 않습니다.',
    };
  } catch (yahooError) {
    try {
    const result = await proxyFetch<CoinGeckoSimple>({
      key: 'morning-briefing:coingecko:bitcoin-usd',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true',
      ttlSec: 300,
      staleGraceSec: 3600,
    });
    const row = result.data.bitcoin;
    if (!finite(row?.usd) || row.usd <= 0) throw new Error('비트코인 가격이 누락되었습니다.');
    const asOfMillis = finite(row.last_updated_at) ? row.last_updated_at * 1000 : result.fetchedAt;
    return {
      key: 'btc', label: '비트코인', value: row.usd, unit: 'USD',
      changePercent: finite(row.usd_24h_change) ? row.usd_24h_change : null,
      changeBasis: 'rolling-24h', asOfBasis: finite(row.last_updated_at) ? 'provider' : 'received',
      asOf: iso(asOfMillis), fetchedAt: iso(result.fetchedAt), provider: 'CoinGecko', source: result.source,
      freshness: sourceStatus(result.source, asOfMillis, 15 * 60_000),
    };
    } catch (coinGeckoError) {
      const yahooMessage = yahooError instanceof Error ? yahooError.message : '';
      const coinGeckoMessage = coinGeckoError instanceof Error ? coinGeckoError.message : '';
      return failed('btc', '비트코인', 'USD', 'CoinGecko', new Error(`${yahooMessage} ${coinGeckoMessage}`.trim()));
    }
  }
}

export function buildDailyView(indicators: MarketIndicator[]): MarketBriefing['dailyView'] {
  const available = indicators.filter((item) => item.value != null);
  const map = new Map(available.map((item) => [item.key, item]));
  const evidenceKeys = available.map((item) => item.key);
  if (!available.length) {
    return {
      headline: '확인된 시장지표가 없습니다',
      interpretation: '제공처 응답을 확인한 뒤 브리핑을 다시 생성해 주세요.',
      checklist: ['새로고침 후 각 지표의 제공처와 기준시각을 확인하세요.'],
      evidenceKeys: [],
    };
  }

  const risk = buildRisk(indicators);
  const headline = risk.level === 'high'
    ? '금리·환율 변동 위험을 우선 점검할 구간입니다'
    : risk.level === 'moderate'
      ? '확인된 지표에 일부 주의 신호가 있습니다'
      : '확인된 지표의 위험 신호는 제한적입니다';
  const facts: string[] = [];
  const ten = map.get('us10y');
  const thirty = map.get('us30y');
  if (ten && thirty) facts.push(`미 국채 10년물 ${ten.value!.toFixed(2)}%, 30년물 ${thirty.value!.toFixed(2)}%`);
  const jpy = map.get('usdjpy');
  const krw = map.get('usdkrw');
  if (jpy && krw) facts.push(`달러/엔 ${jpy.value!.toFixed(2)}, 원/달러 ${krw.value!.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`);
  const btc = map.get('btc');
  if (btc) facts.push(`비트코인 $${btc.value!.toLocaleString('en-US', { maximumFractionDigits: 0 })}${btc.changePercent == null ? '' : ` (${btc.changePercent >= 0 ? '+' : ''}${btc.changePercent.toFixed(2)}%)`}`);
  if (!facts.length) facts.push(`${available.length}개 지표의 최신 확인값`);

  const checklist: string[] = [];
  if (ten) checklist.push(ten.value! >= 4.5 ? '10년물 4.5% 이상 지속 여부와 성장주 변동성을 함께 확인하세요.' : '10년물의 4.5% 재진입 여부를 확인하세요.');
  if (krw) checklist.push(krw.value! >= 1400 ? '원/달러 1,400원 이상에서는 주가 수익과 환율 효과를 분리해 보세요.' : '해외주식 수익률에서 환율 효과를 분리해 기록하세요.');
  if (btc) checklist.push(btc.changePercent == null ? '비트코인 가격은 확인됐지만 24시간 등락은 미확인입니다. 변동 위험을 단정하지 마세요.' : '비트코인 24시간 등락과 위험자산의 방향이 같은지 확인하세요.');
  if (!checklist.length) checklist.push('확인된 지표의 기준시각과 다음 갱신값을 비교하세요.');
  return {
    headline,
    interpretation: `${facts.join(' · ')}가 확인됐습니다. ${risk.score == null ? '수치가 더 확보되기 전에는 방향을 단정하지 않습니다.' : `규칙 기반 위험도는 ${risk.score}점입니다.`}`,
    checklist,
    evidenceKeys,
  };
}

async function yahooIndicator(key: 'usdjpy' | 'usdkrw', symbol: 'JPY=X' | 'KRW=X', label: string, unit: 'JPY/USD' | 'KRW/USD'): Promise<MarketIndicator> {
  try {
    const response = await getYahooQuote(symbol, '1d', '1d');
    return {
      key, label, value: response.quote.price, unit, changePercent: response.quote.changePercent,
      asOf: response.quote.asOf, fetchedAt: response.fetchedAt, provider: 'Yahoo Finance',
      source: response.source as MarketIndicator['source'], freshness: response.source === 'stale' ? 'stale' : 'fresh',
    };
  } catch (error) {
    return failed(key, label, unit, 'Yahoo Finance', error);
  }
}

async function fredYield(key: 'us10y' | 'us30y', seriesId: 'DGS10' | 'DGS30', label: string): Promise<MarketIndicator> {
  if (!hasFredKey()) return yahooYield(key, key === 'us10y' ? '^TNX' : '^TYX', label);
  try {
    const params = new URLSearchParams({ series_id: seriesId, api_key: config.fredApiKey, file_type: 'json', sort_order: 'desc', limit: '10' });
    const result = await proxyFetch<FredResponse>({
      key: `morning-briefing:fred:${seriesId}`,
      url: `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`,
      ttlSec: config.cache.macro,
      staleGraceSec: 7 * 86400,
    });
    const observation = (result.data.observations ?? []).find((item) => item.value && item.value !== '.' && Number.isFinite(Number(item.value)) && item.date);
    if (!observation?.date) throw new Error(`${seriesId} 최신 관측값이 없습니다.`);
    const value = Number(observation.value);
    const asOfMillis = Date.parse(`${observation.date}T00:00:00Z`);
    return {
      key, label, value, unit: '%', changePercent: null, asOf: iso(asOfMillis), fetchedAt: iso(result.fetchedAt), provider: 'FRED',
      source: result.source, freshness: sourceStatus(result.source, asOfMillis, 7 * 86400_000),
    };
  } catch {
    return yahooYield(key, key === 'us10y' ? '^TNX' : '^TYX', label);
  }
}

async function yahooYield(key: 'us10y' | 'us30y', symbol: '^TNX' | '^TYX', label: string): Promise<MarketIndicator> {
  try {
    const response = await getYahooQuote(symbol, '1d', '1d');
    const raw = response.quote.price;
    const value = raw > 20 ? raw / 10 : raw;
    return {
      key, label, value, unit: '%', changePercent: response.quote.changePercent,
      asOf: response.quote.asOf, fetchedAt: response.fetchedAt, provider: 'Yahoo Finance',
      source: response.source as MarketIndicator['source'], freshness: response.source === 'stale' ? 'stale' : 'fresh',
    };
  } catch (error) {
    return failed(key, label, '%', 'Yahoo Finance', error);
  }
}

export function buildRisk(indicators: MarketIndicator[]): MarketBriefing['risk'] {
  const values = new Map(indicators.filter((item) => item.value != null).map((item) => [item.key, item]));
  let points = 0;
  let maximum = 0;
  const keys: MarketIndicatorKey[] = [];
  const add = (key: MarketIndicatorKey, first: boolean, second: boolean) => {
    if (!values.has(key)) return;
    maximum += 2; keys.push(key); points += second ? 2 : first ? 1 : 0;
  };
  const btc = values.get('btc');
  // BTC's risk rule is based on its published 24-hour move.  A price without
  // that comparison is still shown in the snapshot, but must not quietly add
  // a zero-volatility point to the risk-score denominator.
  if (btc?.changePercent != null) {
    const btcMove = Math.abs(btc.changePercent);
    add('btc', btcMove >= 2, btcMove >= 5);
  }
  add('usdjpy', (values.get('usdjpy')?.value ?? 0) >= 145, (values.get('usdjpy')?.value ?? 0) >= 155);
  add('usdkrw', (values.get('usdkrw')?.value ?? 0) >= 1350, (values.get('usdkrw')?.value ?? 0) >= 1450);
  add('us10y', (values.get('us10y')?.value ?? 0) >= 4.5, (values.get('us10y')?.value ?? 0) >= 5);
  add('us30y', (values.get('us30y')?.value ?? 0) >= 4.5, (values.get('us30y')?.value ?? 0) >= 5);
  if (!maximum) return { score: null, level: 'unavailable', method: '확인된 지표가 없어 규칙 기반 점수를 계산하지 않았습니다.', evidenceKeys: [] };
  const score = Math.round(points / maximum * 100);
  return {
    score, level: score >= 67 ? 'high' : score >= 34 ? 'moderate' : 'low',
    method: '확인된 지표별 위험구간 충족 비율(금리 4.5/5%, USDJPY 145/155, USDKRW 1350/1450, BTC 24시간 변동 2/5%)',
    evidenceKeys: keys,
  };
}

export function buildMacroDrivers(indicators: MarketIndicator[]): MarketBriefing['macroDrivers'] {
  const map = new Map(indicators.filter((item) => item.value != null).map((item) => [item.key, item]));
  const drivers: MarketBriefing['macroDrivers'] = [];
  const ten = map.get('us10y'); const thirty = map.get('us30y');
  if (ten && thirty) drivers.push({ tone: Math.max(ten.value!, thirty.value!) >= 4.5 ? 'caution' : 'neutral', text: `미 국채 10년 ${ten.value!.toFixed(2)}%, 30년 ${thirty.value!.toFixed(2)}%로 성장주 할인율과 장기 자금비용을 함께 확인해야 합니다.`, evidenceKeys: ['us10y', 'us30y'] });
  const jpy = map.get('usdjpy'); const krw = map.get('usdkrw');
  if (jpy && krw) drivers.push({ tone: jpy.value! >= 150 || krw.value! >= 1400 ? 'caution' : 'neutral', text: `달러/엔 ${jpy.value!.toFixed(2)}, 원/달러 ${krw.value!.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}로 달러 강도와 환노출을 점검합니다.`, evidenceKeys: ['usdjpy', 'usdkrw'] });
  const btc = map.get('btc');
  if (btc) drivers.push({ tone: Math.abs(btc.changePercent ?? 0) >= 5 ? 'caution' : (btc.changePercent ?? 0) > 0 ? 'positive' : 'neutral', text: `비트코인 $${btc.value!.toLocaleString('en-US', { maximumFractionDigits: 0 })}${btc.changePercent == null ? '' : `, 24시간 ${btc.changePercent >= 0 ? '+' : ''}${btc.changePercent.toFixed(2)}%`}로 위험선호 흐름을 확인합니다.`, evidenceKeys: ['btc'] });
  return drivers;
}

export function buildScenarios(indicators: MarketIndicator[]): MarketBriefing['scenarios'] {
  const available = new Map(indicators.filter((item) => item.value != null).map((item) => [item.key, item.value!]));
  const scenarios: MarketBriefing['scenarios'] = [];
  const ten = available.get('us10y');
  if (ten != null) scenarios.push({ tone: ten >= 4.5 ? 'caution' : 'positive', title: '금리 시나리오', text: ten >= 4.5 ? '10년물이 4.5% 이상에 머물면 고밸류 성장주의 변동성 확대 가능성을 우선 점검하세요.' : '10년물이 4.5% 아래에서 안정되면 성장주의 할인율 부담이 완화되는지 확인하세요.', evidenceKeys: ['us10y'] });
  const krw = available.get('usdkrw');
  if (krw != null) scenarios.push({ tone: krw >= 1400 ? 'caution' : 'neutral', title: '환율 시나리오', text: krw >= 1400 ? '원/달러 1,400원 이상에서는 미국주식 평가액과 신규 환전 비용을 분리해 판단하세요.' : '원/달러가 1,400원 아래일 때도 주가 수익과 환율 효과를 분리해 기록하세요.', evidenceKeys: ['usdkrw'] });
  return scenarios;
}

export async function getMarketBriefing(): Promise<MarketBriefing> {
  const indicators = await Promise.all([
    bitcoin(),
    yahooIndicator('usdjpy', 'JPY=X', '달러/엔 환율', 'JPY/USD'),
    yahooIndicator('usdkrw', 'KRW=X', '원/달러 환율', 'KRW/USD'),
    fredYield('us10y', 'DGS10', '미국채 10년물'),
    fredYield('us30y', 'DGS30', '미국채 30년물'),
  ]);
  const succeeded = indicators.filter((item) => item.value != null).length;
  return {
    generatedAt: new Date().toISOString(),
    coverage: { status: succeeded === indicators.length ? 'complete' : succeeded ? 'partial' : 'failed', requested: indicators.length, succeeded, failed: indicators.length - succeeded },
    indicators,
    dailyView: buildDailyView(indicators),
    macroDrivers: buildMacroDrivers(indicators),
    scenarios: buildScenarios(indicators),
    risk: buildRisk(indicators),
  };
}
