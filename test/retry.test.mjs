import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuery, searchUrl } from '../topic-audit.mjs';

const QUERY = 'topic:dsh-plugin';
const PAGE = searchUrl(QUERY, 1);
const OK = { status: 200, text: JSON.stringify({ total_count: 1, items: [{ full_name: 'o/a' }] }) };

test('fetchQuery: retries a 403 and then succeeds', async () => {
  let calls = 0;
  const retried = [];
  const http = async () => {
    calls += 1;
    return calls === 1 ? { status: 403, text: 'rate limited' } : OK;
  };
  const res = await fetchQuery(QUERY, { http, retryDelays: [1], onRetry: (q, p, s, w, n) => retried.push([s, w, n]) });
  assert.equal(calls, 2);
  assert.equal(res.repos.length, 1);
  assert.equal(res.retries, 1);
  assert.deepEqual(retried, [[403, 1, 1]]);
});

test('fetchQuery: a 429 is retried the same way', async () => {
  let calls = 0;
  const http = async () => {
    calls += 1;
    return calls <= 2 ? { status: 429, text: 'slow down' } : OK;
  };
  const res = await fetchQuery(QUERY, { http, retryDelays: [1, 1] });
  assert.equal(calls, 3);
  assert.equal(res.retries, 2);
});

test('fetchQuery: gives up loudly after the retry budget', async () => {
  let calls = 0;
  const http = async () => { calls += 1; return { status: 403, text: 'nope' }; };
  await assert.rejects(
    () => fetchQuery(QUERY, { http, retryDelays: [1, 1] }),
    /rate limit hit .* after 2 retries/,
  );
  assert.equal(calls, 3);
});

test('fetchQuery: --delay spaces the queries out', async () => {
  const stamps = [];
  const http = async (url) => {
    stamps.push([url, Date.now()]);
    return { status: 200, text: JSON.stringify({ total_count: 200, items: Array.from({ length: 100 }, (_, i) => ({ full_name: 'o/r' + i })) }) };
  };
  await fetchQuery(QUERY, { http, delay: 30 });
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1][1] - stamps[0][1] >= 25, 'second query waited at least ~30ms');
});