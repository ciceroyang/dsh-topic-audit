import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateFull, runAudit, searchUrl, STAR_BANDS } from '../topic-audit.mjs';

function fakeHttp(routes) {
  return async (url) => (Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : { status: 404, text: '' });
}

function capped(query, page) {
  return [searchUrl(query, page), {
    status: 200,
    text: JSON.stringify({ total_count: 5000, items: Array.from({ length: 100 }, (_, i) => ({ full_name: 'o/root' + i })) }),
  }];
}

function small(query, names) {
  return [searchUrl(query, 1), {
    status: 200,
    text: JSON.stringify({ total_count: names.length, items: names.map((n) => ({ full_name: n })) }),
  }];
}

test('enumerateFull: splits a capped window by date and dedupes across windows', async () => {
  const root = 'topic:dsh-plugin stars:0 created:2020-01-01..2020-01-09';
  const routes = {};
  for (let p = 1; p <= 10; p += 1) {
    const [url, res] = capped(root, p);
    routes[url] = res;
  }
  routes[small('topic:dsh-plugin stars:0 created:2020-01-01..2020-01-05', ['o/a', 'o/b'])[0]] = small('topic:dsh-plugin stars:0 created:2020-01-01..2020-01-05', ['o/a', 'o/b'])[1];
  routes[small('topic:dsh-plugin stars:0 created:2020-01-06..2020-01-09', ['o/b', 'o/c'])[0]] = small('topic:dsh-plugin stars:0 created:2020-01-06..2020-01-09', ['o/b', 'o/c'])[1];
  const res = await enumerateFull({ http: fakeHttp(routes), bands: ['0'], from: '2020-01-01', to: '2020-01-09' });
  assert.equal(res.coverage[0].windows, 3);
  assert.equal(res.coverage[0].truncated, false);
  const names = res.repos.map((r) => r.full_name);
  assert.equal(names.filter((n) => n === 'o/b').length, 1);
  assert.ok(names.includes('o/a') && names.includes('o/c'));
});

test('enumerateFull: a single-day window that is still capped is flagged, not silently dropped', async () => {
  const root = 'topic:dsh-plugin stars:0 created:2020-01-01..2020-01-01';
  const routes = {};
  for (let p = 1; p <= 10; p += 1) {
    const [url, res] = capped(root, p);
    routes[url] = res;
  }
  const res = await enumerateFull({ http: fakeHttp(routes), bands: ['0'], from: '2020-01-01', to: '2020-01-01' });
  assert.equal(res.coverage[0].truncated, true);
  assert.equal(res.coverage[0].windows, 1);
});

test('enumerateFull: maxQueries stops a runaway walk and says so', async () => {
  const root = 'topic:dsh-plugin stars:0 created:2020-01-01..2020-12-31';
  const routes = {};
  for (let p = 1; p <= 10; p += 1) {
    const [url, res] = capped(root, p);
    routes[url] = res;
  }
  const res = await enumerateFull({ http: fakeHttp(routes), bands: ['0'], from: '2020-01-01', to: '2020-12-31', maxQueries: 1 });
  assert.equal(res.coverage[0].hitQueryLimit, true);
});

test('runAudit --full: reports the probe total and per-band window counts', async () => {
  const probe = 'topic:dsh-plugin';
  const routes = {};
  routes[searchUrl(probe, 1)] = { status: 200, text: JSON.stringify({ total_count: 14846, items: [{ full_name: 'o/probe' }] }) };
  for (const band of STAR_BANDS) {
    const q = 'topic:dsh-plugin stars:' + band + ' created:2020-01-01..2020-01-09';
    routes[searchUrl(q, 1)] = { status: 200, text: JSON.stringify({ total_count: 0, items: [] }) };
  }
  routes[small('topic:dsh-plugin stars:>=10000 created:2020-01-01..2020-01-09', ['o/plugin'])[0]] = small('topic:dsh-plugin stars:>=10000 created:2020-01-01..2020-01-09', ['o/plugin'])[1];
  routes['https://raw.githubusercontent.com/o/plugin/HEAD/cordis.patch.yml'] = { status: 200, text: 'patch: []' };
  const audit = await runAudit({ http: fakeHttp(routes), full: true, from: '2020-01-01', to: '2020-01-09' });
  assert.equal(audit.total, 14846);
  assert.equal(audit.scanned, 1);
  assert.equal(audit.summary.plugin, 1);
  assert.ok(typeof audit.queries === 'number');
});