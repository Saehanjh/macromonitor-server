import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalPoints, instrumentCandidates, summarizeQuote } from './yahoo';

const regularChart = {
  result: [{
    meta: {
      currency: 'USD',
      regularMarketPrice: 132.7,
      regularMarketTime: 1_700_000_000,
      // Deliberately different from a calculation based on previous close.
      // The mobile contract must retain Yahoo's published regular percentage.
      regularMarketChangePercent: 6.26,
      previousClose: 124.88,
    },
    timestamp: [1_699_990_000],
    indicators: { quote: [{ close: [132.7] }] },
  }],
};

test('regular quote keeps Yahoo published percentage and regular timestamp', () => {
  const quote = summarizeQuote(regularChart);
  assert.equal(quote.price, 132.7);
  assert.equal(quote.changePercent, 6.26);
  assert.equal(quote.session, 'regular');
  assert.equal(quote.changeBasis, 'previous_close');
  assert.equal(quote.asOf, new Date(1_700_000_000 * 1000).toISOString());
});

test('newer intraday bar is explicitly an extended-hours quote', () => {
  const quote = summarizeQuote({
    result: [{
      meta: { currency: 'USD', regularMarketPrice: 100, regularMarketTime: 1_700_000_000, regularMarketChangePercent: 2 },
      timestamp: [1_700_000_120],
      indicators: { quote: [{ close: [103] }] },
    }],
  });
  assert.equal(quote.price, 103);
  assert.equal(quote.session, 'extended');
  assert.equal(quote.changeBasis, 'regular_close');
  assert.ok(Math.abs((quote.changePercent ?? 0) - 3) < 1e-10);
});

test('instrument candidates preserve US symbols and resolve both Korean exchanges', () => {
  assert.deepEqual(instrumentCandidates('app', 'US'), ['APP']);
  assert.deepEqual(instrumentCandidates('357780', 'KR'), ['357780.KS', '357780.KQ']);
  assert.deepEqual(instrumentCandidates('005930.KS', 'KR'), ['005930.KS']);
  assert.deepEqual(instrumentCandidates('../bad', 'US'), []);
});

test('historical points omit incomplete or invalid provider bars', () => {
  assert.deepEqual(historicalPoints({
    result: [{ meta: {}, timestamp: [10, 20, 30, 40], indicators: { quote: [{ close: [12, null, -1, 15] }] } }],
  }), [{ t: 10, close: 12 }, { t: 40, close: 15 }]);
});
