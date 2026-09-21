import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUSMarketUpdate, EquitySnapshot } from './usMarketUpdate';
import { MarketBriefing } from './marketBriefing';

const briefing: MarketBriefing = {
  generatedAt: '2026-09-17T12:00:00.000Z',
  coverage: { status: 'partial', requested: 5, succeeded: 4, failed: 1 },
  indicators: [{ key: 'us10y', label: '미국채 10년물', value: 4.2, unit: '%', changePercent: null, asOf: '2026-09-17T00:00:00.000Z', fetchedAt: '2026-09-17T12:00:00.000Z', provider: 'FRED', source: 'fresh', freshness: 'fresh' }],
  dailyView: { headline: '확인된 지표', interpretation: '근거 기반', checklist: [], evidenceKeys: ['us10y'] },
  macroDrivers: [], scenarios: [], risk: { score: 0, level: 'low', method: 'test', evidenceKeys: ['us10y'] },
};

const equity: EquitySnapshot = { symbol: 'SPY', label: 'S&P 500 ETF', value: 500, changePercent: 0.5, asOf: '2026-09-17T15:30:00.000Z', fetchedAt: '2026-09-17T15:31:00.000Z', provider: 'Yahoo Finance', source: 'fresh' };

test('US market report preserves provider timestamps and real headline links', () => {
  const report = buildUSMarketUpdate(briefing, [equity], [{ id: 'n1', title: 'Fed update', source: 'Federal Reserve', url: 'https://example.test/fed', publishedAt: '2026-09-17T14:00:00.000Z', category: 'fed', highlight: true }], new Date('2026-09-17T16:00:00.000Z'));
  assert.equal(report.reportDate, '2026-09-17');
  assert.equal(report.generatedAt, '2026-09-17T16:00:00.000Z');
  assert.equal(report.equities[0].asOf, equity.asOf);
  assert.equal(report.equities[0].fetchedAt, equity.fetchedAt);
  assert.equal(report.headlines[0].url, 'https://example.test/fed');
  assert.equal(report.sources[0].asOf, briefing.indicators[0].asOf);
});

test('partial ETF providers remain explicit and report coverage is retained', () => {
  const unavailable: EquitySnapshot = { symbol: 'QQQ', label: '나스닥 100 ETF', value: null, changePercent: null, asOf: null, fetchedAt: null, provider: 'Yahoo Finance', source: 'unavailable', message: 'unavailable' };
  const report = buildUSMarketUpdate(briefing, [equity, unavailable], []);
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.equities[1].source, 'unavailable');
  assert.equal(report.headlines.length, 0);
});
