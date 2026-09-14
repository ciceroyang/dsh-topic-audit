import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuery, fetchTopicByBands, runAudit, searchUrl, SEARCH_WINDOW, STAR_BANDS } from '../topic-audit.mjs';

// Every band the audit walks needs a route; default them to empty, override per test.
function emptyBands(routes) {
  for (const band of STAR_BANDS) {
    routes[searchUrl('topic:dsh-plugin stars:' + band, 1)] = { status: 200, text: JSON.stringify({ total_count: 0, items: [] }) };
  }
  return routes;
}

function fakeHttp(routes, seen) {
  return async (url) => {
    if (seen) seen.push(url);
    if (Object.prototype.hasOwnProperty.call(routes, url)) return routes[url];
    return { status: 404, text: '' };
  };
}

function page(query, n, total, offset) {
  const items = Array.from({ length: n }, (_, i) => ({ full_name: 'o/r' + (offset || 0) + i, stargazers_count: 1 }));
  return [searchUrl(query, offset === undefined ? 1 : Math.floor((offset || 0) / 100) + 1), {
    status: 200,
    text: JSON.stringify({ total_count: total, items }),
  }];
}

test('searchUrl: encodes the topic qualifier and page', () => {
  assert.equal(searchUrl('topic:dsh-plugin', 3), 'https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&order=desc&per_page=100&page=3');
  assert.match(searchUrl('topic:dsh-plugin stars:0', 1), /q=topic%3Adsh-plugin%20stars%3A0/);
});

test('fetchQuery: caps at max and flags the cap', async () => {
  const query = 'topic:dsh-plugin';
  const routes = Object.fromEntries([page(query, 100, 500, 0)]);
  const res = await fetchQuery(query, { http: fakeHttp(routes), max: 7 });
  assert.equal(res.repos.length, 7);
  assert.equal(res.capped, true);
  assert.equal(res.total, 500);
});

test('fetchQuery: never walks past the 1000-result search window', async () => {
  const query = 'topic:dsh-plugin';
  const routes = {};
  for (let p = 1; p <= 12; p += 1) {
    routes[searchUrl(query, p)] = { status: 200, text: JSON.stringify({ total_count: 5000, items: Array.from({ length: 100 }, (_, i) => ({ full_name: 'o/p' + p + 'r' + i })) }) };
  }
  const seen = [];
  const res = await fetchQuery(query, { http: fakeHttp(routes, seen) });
  assert.equal(res.repos.length, SEARCH_WINDOW);
  assert.equal(seen.length, 10);
  assert.equal(res.capped, true);
});

test('fetchTopicByBands: dedupes a repo that appears in two star bands', async () => {
  const shared = { full_name: 'o/shared', stargazers_count: 9000 };
  const routes = {};
  routes[searchUrl('topic:dsh-plugin stars:>=10000', 1)] = { status: 200, text: JSON.stringify({ total_count: 1, items: [shared] }) };
  routes[searchUrl('topic:dsh-plugin stars:5000..9999', 1)] = { status: 200, text: JSON.stringify({ total_count: 1, items: [shared] }) };
  const res = await fetchTopicByBands({ http: fakeHttp(routes), bands: ['>=10000', '5000..9999'] });
  assert.equal(res.repos.length, 1);
  assert.equal(res.coverage[0].added, 1);
  assert.equal(res.coverage[1].added, 0);
  assert.equal(res.coverage[1].found, 1);
});

test('fetchTopicByBands: flags a band that hits the search window', async () => {
  const routes = {};
  routes[searchUrl('topic:dsh-plugin stars:0', 1)] = { status: 200, text: JSON.stringify({ total_count: 9000, items: Array.from({ length: 100 }, (_, i) => ({ full_name: 'o/zero' + i })) }) };
  for (let p = 2; p <= 10; p += 1) routes[searchUrl('topic:dsh-plugin stars:0', p)] = routes[searchUrl('topic:dsh-plugin stars:0', 1)];
  const res = await fetchTopicByBands({ http: fakeHttp(routes), bands: ['0'] });
  assert.equal(res.coverage[0].capped, true);
  assert.equal(res.coverage[0].total, 9000);
});

test('runAudit --bands: takes the topic total from a probe query and reports coverage', async () => {
  const routes = emptyBands({});
  routes[searchUrl('topic:dsh-plugin', 1)] = { status: 200, text: JSON.stringify({ total_count: 14846, items: [{ full_name: 'o/probe' }] }) };
  routes[searchUrl('topic:dsh-plugin stars:>=10000', 1)] = { status: 200, text: JSON.stringify({ total_count: 1, items: [{ full_name: 'o/real', stargazers_count: 20000 }] }) };
  routes[searchUrl('topic:dsh-plugin stars:0', 1)] = { status: 200, text: JSON.stringify({ total_count: 1, items: [{ full_name: 'o/pollution', stargazers_count: 0 }] }) };
  routes['https://raw.githubusercontent.com/o/real/HEAD/cordis.patch.yml'] = { status: 200, text: 'patch: []' };
  const audit = await runAudit({ http: fakeHttp(routes), bands: true });
  assert.equal(audit.total, 14846);
  assert.equal(audit.scanned, 2);
  assert.equal(audit.summary.plugin, 1);
  assert.equal(audit.summary['not-a-plugin'], 1);
  assert.equal(audit.coverage.length, 14);
  assert.equal(audit.coverage[0].band, '>=10000');
  assert.equal(audit.coverage[1].added, 0);
});

test('bands mode needs no --max and still scans everything it found', async () => {
  const routes = emptyBands({});
  routes[searchUrl('topic:dsh-plugin', 1)] = { status: 200, text: JSON.stringify({ total_count: 2, items: [{ full_name: 'o/probe' }] }) };
  routes[searchUrl('topic:dsh-plugin stars:>=10000', 1)] = { status: 200, text: JSON.stringify({ total_count: 1, items: [{ full_name: 'o/a', stargazers_count: 5 }] }) };
  routes['https://raw.githubusercontent.com/o/a/HEAD/readme.md'] = { status: 200, text: 'for DeepSeek Harness' };
  const audit = await runAudit({ http: fakeHttp(routes), bands: true });
  assert.equal(audit.scanned, 1);
  assert.equal(audit.summary.companion, 1);
});