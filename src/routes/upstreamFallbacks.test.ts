import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFredGraphCsv } from './economy';
import { stableSeriesFromCharts } from './onchain';

test('FRED public CSV parser keeps only genuine numeric observations', () => {
  const csv = 'observation_date,GDPNOW\n2026-01-01,2.3\n2026-02-01,.\n2026-03-01,2.7\n';
  assert.deepEqual(parseFredGraphCsv(csv, 2), [
    { t: Math.floor(Date.parse('2026-01-01') / 1000), v: 2.3 },
    { t: Math.floor(Date.parse('2026-03-01') / 1000), v: 2.7 },
  ]);
});

test('DefiLlama stablecoin histories produce only matched real observations', () => {
  const now = Math.floor(Date.now() / 1000);
  const series = stableSeriesFromCharts(
    [{ date: now - 86_400, circulating: { peggedUSD: 100_000_000_000 } }, { date: now, circulating: { peggedUSD: 101_000_000_000 } }],
    [{ date: now - 86_400, circulating: { peggedUSD: 50_000_000_000 } }, { date: now, circulating: { peggedUSD: 49_000_000_000 } }],
    30,
  );
  assert.equal(series.length, 2);
  assert.deepEqual(series[1], { t: now, total: 150, dominance: 32.67 });
});
