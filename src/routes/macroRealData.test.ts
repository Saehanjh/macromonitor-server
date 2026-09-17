import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import axios from 'axios';
import { config } from '../config';
import * as cache from '../services/cache';
import markets from './markets';
import economy from './economy';
import global from './global';
import onchain from './onchain';
import treasury from './treasury';
import { missingMacroInputs } from '../middleware/realMacroData';

test('production macro routes return unavailable rather than fictional observations', async () => {
  const originalAdapter = axios.defaults.adapter;
  const originalKey = config.fredApiKey;
  Object.assign(config, { fredApiKey: 'test-only-key' });
  axios.defaults.adapter = async () => { throw new Error('provider unavailable'); };
  cache.clear();
  const app = express();
  app.use('/markets', markets); app.use('/economy', economy); app.use('/global', global);
  app.use('/onchain', onchain); app.use('/treasury', treasury);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const paths = ['/markets/volatility', '/markets/plumbing', '/markets/history/vix', '/markets/capital-migration', '/markets/sectors', '/markets/leverage', '/markets/liquidity-flow', '/markets/mmf-deposits', '/markets/repo-phase', '/markets/rates', '/markets/credit', '/economy/commodities', '/economy/inflation', '/economy/expectations', '/economy/corporate', '/economy/labor', '/economy/consumer', '/global/dollar', '/global/factory', '/global/demand', '/onchain/stablecoins', '/onchain/rwa', '/onchain/btc-etf', '/treasury/auctions', '/treasury/plumbing'];
    for (const path of paths) {
      const response = await fetch(base + path);
      assert.equal(response.status, 503, path);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.error, 'macro_data_unavailable', path);
      assert.equal(body.source, undefined, path);
    }
    // A real FRED-only path must still work, using original provider values.
    cache.set('fred:RRPONTSYD:p:25', { observations: [{ date: '2026-09-10', value: '120.5' }, { date: '2026-09-09', value: '121.3' }] }, 60, 0);
    cache.set('fred:SOFR:p:35', { observations: [{ date: '2026-09-10', value: '4.33' }, { date: '2026-09-09', value: '4.32' }] }, 60, 0);
    const repo = await fetch(base + '/markets/repo-phase');
    assert.equal(repo.status, 200);
    const body = await repo.json() as { source: string; rrp: { points: Array<{ v: number }> } };
    assert.equal(body.source, 'live');
    assert.deepEqual(body.rrp.points.map(p => p.v), [121.3, 120.5]);

    cache.set('fred:WALCL:p:70', { observations: [{ date: '2026-09-10', value: '7100000' }] }, 60, 0);
    cache.set('fred:WTREGEN:p:420', { observations: [{ date: '2026-09-10', value: '760000' }] }, 60, 0);
    cache.set('fred:RRPONTSYD:p:420', { observations: [{ date: '2026-09-10', value: '420' }] }, 60, 0);
    cache.set('fred:SP500:p:270', { observations: [{ date: '2026-09-10', value: '6200' }] }, 60, 0);
    const liquidity = await fetch(base + '/markets/liquidity-flow');
    assert.equal(liquidity.status, 200);
    const flow = await liquidity.json() as { netLiquidity: { points: Array<{ v: number }> }; sp500: { points: Array<{ v: number }> } };
    assert.equal(flow.netLiquidity.points[0].v, 5920);
    assert.equal(flow.sp500.points[0].v, 6200);

    cache.set('fred:VIXCLS:p:130', { observations: [{ date: '2026-09-10', value: '18.2' }, { date: '2026-09-09', value: '18' }] }, 60, 0);
    const vol = await fetch(base + '/markets/volatility');
    assert.equal(vol.status, 200);
    const volatility = await vol.json() as { source: string; vix: { value: number }; move: { value: number | null; available: boolean }; verdictLabel: string };
    assert.equal(volatility.source, 'partial');
    assert.equal(volatility.vix.value, 18.2);
    assert.equal(volatility.move.value, null);
    assert.equal(volatility.move.available, false);
    assert.match(volatility.verdictLabel, /확인 불가/);

    cache.set('fred:WALCL:p:10', { observations: [{ date: '2026-09-10', value: '7100000' }] }, 60, 0);
    cache.set('fred:STLFSI4:p:10', { observations: [{ date: '2026-09-10', value: '0.25' }] }, 60, 0);
    const plumbing = await fetch(base + '/markets/plumbing');
    assert.equal(plumbing.status, 200);
    const pressure = await plumbing.json() as { source: string; coverage: { available: number; total: number }; groups: Array<{ indicators: Array<{ key: string; available: boolean; value: string }> }> };
    assert.equal(pressure.source, 'partial');
    assert.ok(pressure.coverage.available > 0);
    assert.ok(pressure.coverage.available < pressure.coverage.total);
    assert.ok(pressure.groups.flatMap(group => group.indicators).some(item => item.key === 'srfUsage' && item.available === false && item.value === '확인 불가'));
  } finally {
    server.close(); axios.defaults.adapter = originalAdapter;
    Object.assign(config, { fredApiKey: originalKey }); cache.clear();
  }
});

test('mixed live and missing series is rejected; real nullable auction fields remain valid', () => {
  assert.deepEqual(missingMacroInputs({ source: 'live', netLiquidity: { points: [{ t: 1, v: 10 }] }, sp500: { points: [] } }), ['sp500.points']);
  assert.deepEqual(missingMacroInputs({ auctions: [{ highYield: null, interestRate: null, upcoming: true }], source: 'live' }), []);
  assert.deepEqual(missingMacroInputs({ source: 'live', mfg: { components: [{ live: false, value: -8 }] } }), ['mfg.components[0].live']);
});
