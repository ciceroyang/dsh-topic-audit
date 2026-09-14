import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary } from '../scripts/summary.mjs';

const payload = {
  total: 14846,
  scanned: 5007,
  summary: { plugin: 3633, companion: 1115, 'not-a-plugin': 259, unavailable: 0 },
  results: [
    { full_name: 'o/small', stars: 2, category: 'not-a-plugin', evidence: 'README present, no DSH relationship' },
    { full_name: 'o/big', stars: 42000, category: 'not-a-plugin', evidence: 'README present, no DSH relationship' },
    { full_name: 'o/real', stars: 9, category: 'plugin', evidence: 'root manifest: cordis.patch.yml' },
  ],
};

test('renderSummary: states coverage and counts', () => {
  const text = renderSummary(payload);
  assert.match(text, /Scanned 5007 of 14846/);
  assert.match(text, /3633 plugin/);
  assert.match(text, /259 not-a-plugin/);
});

test('renderSummary: lists only not-a-plugin rows, highest stars first', () => {
  const text = renderSummary(payload);
  const rows = text.split('\n').filter((line) => line.startsWith('| [') );
  assert.equal(rows.length, 2);
  assert.match(rows[0], /o\/big/);
  assert.match(rows[1], /o\/small/);
});

test('renderSummary: omits the table when there is nothing to report', () => {
  const text = renderSummary({ ...payload, results: [], summary: { plugin: 1, companion: 0, 'not-a-plugin': 0 } });
  assert.ok(!text.includes('| --- |'));
  assert.match(text, /Reproduce with/);
});