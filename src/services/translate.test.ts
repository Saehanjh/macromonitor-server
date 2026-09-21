import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTranslate, translateBatch } from './translate';

test('offline headline fallback produces Korean without dropping the source title', () => {
  const original = 'Bitcoin rises above $81,000, while NEAR jumps 23% on Zcash swap traffic';
  const translated = fallbackTranslate(original);
  assert.match(translated, /비트코인/);
  assert.match(translated, /81,000/);
  assert.match(translated, /23%/);
  assert.notEqual(translated, original);
});

test('translation batch always returns one title per source item', async () => {
  const input = ['Bitcoin rises above $81,000', 'Oil falls as crude flows remain strong'];
  const output = await translateBatch(input);
  assert.equal(output.length, input.length);
  assert.match(output[0], /비트코인/);
});
