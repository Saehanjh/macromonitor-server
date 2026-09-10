import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEvidence, evidenceKey, instrumentId, normalizeTicker, validatePositiveFinite, validateSnapshotInput } from './personalStore';

test('personal read model validates symbols and numeric holding inputs', () => {
  assert.equal(normalizeTicker('  nvo '), 'NVO');
  assert.equal(instrumentId('us', 'nvo'), 'US:NVO');
  assert.equal(validatePositiveFinite(1.25), true);
  assert.equal(validatePositiveFinite(0), false);
  assert.equal(validatePositiveFinite(Number.NaN), false);
  assert.equal(validatePositiveFinite('12'), false);
});

test('event evidence identity is stable and duplicate documents stay known', () => {
  assert.equal(evidenceKey({ id: 'one', instrumentId: 'US:SMR', kind: 'filing', title: 'x', fetchedAt: '2026-01-01', url: ' https://sec.test/a ' }), 'url:https://sec.test/a');
  assert.equal(evidenceKey({ id: 'two', instrumentId: 'US:SMR', kind: 'filing', title: 'x', fetchedAt: '2026-01-01', accessionNumber: '0001', contentHash: 'abc' }), 'accession:0001');
  assert.equal(classifyEvidence('url:https://sec.test/a', new Set(['url:https://sec.test/a']), []), 'known_evidence');
  assert.equal(classifyEvidence('hash:new', new Set(), []), 'new_evidence');
});

test('worker snapshots require parseable evidence records', () => {
  const base = { runId: 'run-1', quotes: [], coverage: { status: 'complete', requested: 0, succeeded: 0, failed: 0, sources: {} }, evidence: [] };
  assert.equal(validateSnapshotInput(base), true);
  assert.equal(validateSnapshotInput({ ...base, evidence: [{ id: 'e1', instrumentId: 'US:SMR', kind: 'filing', title: '', fetchedAt: 'x' }] }), false);
});
