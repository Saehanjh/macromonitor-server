import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDailyView, buildMacroDrivers, buildRisk, buildScenarios, coinbaseBitcoin, MarketIndicator } from './marketBriefing';

test('Coinbase uses true 24h stats, keeps cached time and discloses received-time basis', () => {
  const quote = coinbaseBitcoin({ data: { last: '102000', open: '100000' }, source: 'cache', fetchedAt: Date.now() - 30_000 });
  assert.ok(Math.abs(quote.changePercent! - 2) < 0.00001);
  assert.equal(quote.changeBasis, 'rolling-24h');
  assert.equal(quote.provider, 'Coinbase Exchange');
  assert.equal(quote.asOfBasis, 'received');
  assert.equal(quote.asOf, quote.fetchedAt);
  assert.equal(quote.source, 'cache');
});

test('Coinbase missing opening price is not fabricated and stale data stays stale', () => {
  const quote = coinbaseBitcoin({ data: { last: '102000' }, source: 'stale', fetchedAt: Date.now() - 3600_000 });
  assert.equal(quote.changePercent, null);
  assert.equal(quote.freshness, 'stale');
  assert.throws(() => coinbaseBitcoin({ data: { last: '0', open: '100' }, source: 'fresh', fetchedAt: Date.now() }));
});

function indicator(key: MarketIndicator['key'], value: number | null, changePercent: number | null = null): MarketIndicator {
  const labels: Record<MarketIndicator['key'], string> = { btc: '비트코인', usdjpy: '달러/엔', usdkrw: '원/달러', us10y: '10년물', us30y: '30년물' };
  const units: Record<MarketIndicator['key'], MarketIndicator['unit']> = { btc: 'USD', usdjpy: 'JPY/USD', usdkrw: 'KRW/USD', us10y: '%', us30y: '%' };
  return { key, label: labels[key], value, changePercent, unit: units[key], asOf: value == null ? null : '2026-09-10T00:00:00.000Z', fetchedAt: value == null ? null : '2026-09-10T01:00:00.000Z', provider: key === 'btc' ? 'CoinGecko' : 'FRED', source: value == null ? 'unavailable' : 'fresh', freshness: value == null ? 'unavailable' : 'fresh' };
}

test('risk score uses only observed indicators and discloses its rule', () => {
  const risk = buildRisk([
    indicator('btc', 100_000, 6),
    indicator('usdjpy', 156),
    indicator('usdkrw', null),
    indicator('us10y', 5.1),
    indicator('us30y', 4.6),
  ]);
  assert.equal(risk.score, 88);
  assert.equal(risk.level, 'high');
  assert.deepEqual(risk.evidenceKeys, ['btc', 'usdjpy', 'us10y', 'us30y']);
  assert.match(risk.method, /확인된 지표/);
});

test('partial market data produces only evidence-backed drivers and scenarios', () => {
  const indicators = [indicator('btc', 90_000, -1.2), indicator('us10y', 4.2), indicator('usdkrw', 1375)];
  const drivers = buildMacroDrivers(indicators);
  const scenarios = buildScenarios(indicators);
  assert.equal(drivers.length, 1);
  assert.deepEqual(drivers[0].evidenceKeys, ['btc']);
  assert.equal(scenarios.length, 2);
  assert.ok(scenarios.every((item) => item.evidenceKeys.length > 0));
});

test('risk stays unavailable when providers returned no values', () => {
  const risk = buildRisk([indicator('btc', null), indicator('us10y', null)]);
  assert.equal(risk.score, null);
  assert.equal(risk.level, 'unavailable');
});

test('BTC price without a published 24-hour comparison is shown but does not dilute the risk score', () => {
  const risk = buildRisk([
    indicator('btc', 100_000, null),
    indicator('us10y', 5.1),
  ]);
  assert.equal(risk.score, 100);
  assert.deepEqual(risk.evidenceKeys, ['us10y']);
});

test('daily view remains useful and evidence-backed when four of five indicators are available', () => {
  const view = buildDailyView([
    indicator('btc', null),
    indicator('usdjpy', 148.2),
    indicator('usdkrw', 1362),
    indicator('us10y', 4.3),
    indicator('us30y', 4.5),
  ]);
  assert.equal(view.evidenceKeys.length, 4);
  assert.match(view.interpretation, /10년물 4\.30%/);
  assert.match(view.interpretation, /원\/달러 1,362/);
  assert.ok(view.checklist.length >= 2);
  assert.ok(!view.evidenceKeys.includes('btc'));
});

test('daily view does not invent market facts when every provider is unavailable', () => {
  const view = buildDailyView([indicator('btc', null), indicator('us10y', null)]);
  assert.deepEqual(view.evidenceKeys, []);
  assert.match(view.headline, /확인된 시장지표가 없습니다/);
});
