import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMacroDrivers, buildRisk, buildScenarios, MarketIndicator } from './marketBriefing';

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
