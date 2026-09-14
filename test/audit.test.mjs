import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  auditRepo,
  fetchTopicRepos,
  runAudit,
  renderReport,
  renderMarkdown,
  MANIFEST_NAMES,
} from '../topic-audit.mjs';

// A fake HTTP client: routes is a map from exact URL to { status, text }.
function fakeHttp(routes, seen) {
  return async (url) => {
    if (seen) seen.push(url);
    if (Object.prototype.hasOwnProperty.call(routes, url)) return routes[url];
    return { status: 404, text: '' };
  };
}

function raw(name, file) {
  return 'https://raw.githubusercontent.com/' + name + '/HEAD/' + file;
}

function searchPage(page, items, total) {
  return ['https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&order=desc&per_page=100&page=' + page, {
    status: 200,
    text: JSON.stringify({ total_count: total, items }),
  }];
}

test('classify: root manifest means plugin', () => {
  const verdict = classify({ manifest: { name: 'cordis.patch.yml', text: 'patch: []' }, readme: null });
  assert.equal(verdict.category, 'plugin');
  assert.match(verdict.evidence, /cordis.patch.yml/);
});

test('classify: readme with install instructions means companion', () => {
  const verdict = classify({ manifest: null, readme: { name: 'readme.md', text: 'Install: dsh plugin add @acme/thing' } });
  assert.equal(verdict.category, 'companion');
  assert.match(verdict.evidence, /dsh plugin add/);
});

test('classify: readme that references DeepSeek Harness means companion', () => {
  const verdict = classify({ manifest: null, readme: { name: 'README.md', text: 'A companion CLI for DeepSeek Harness users.' } });
  assert.equal(verdict.category, 'companion');
});

test('classify: hyphen and space spellings of the product name both count', () => {
  for (const spelling of ['deepseek-harness', 'DeepSeek Harness', 'deep seek harness']) {
    const verdict = classify({ manifest: null, readme: { name: 'readme.md', text: 'works with ' + spelling } });
    assert.equal(verdict.category, 'companion', spelling);
  }
});

test('classify: unrelated readme means not-a-plugin', () => {
  const verdict = classify({ manifest: null, readme: { name: 'readme.md', text: 'A resume builder. Bring your own DeepSeek API key.' } });
  assert.equal(verdict.category, 'not-a-plugin');
  assert.match(verdict.evidence, /no DSH relationship/);
});

test('classify: nothing found means not-a-plugin', () => {
  const verdict = classify({ manifest: null, readme: null });
  assert.equal(verdict.category, 'not-a-plugin');
  assert.match(verdict.evidence, /no README/);
});

test('auditRepo: manifest hit short-circuits readme fetching', async () => {
  const seen = [];
  const http = fakeHttp({ [raw('a/plugin', 'cordis.patch.yml')]: { status: 200, text: 'patch: []' } }, seen);
  const row = await auditRepo({ full_name: 'a/plugin', stargazers_count: 3 }, http);
  assert.equal(row.category, 'plugin');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], raw('a/plugin', 'cordis.patch.yml'));
});

test('auditRepo: falls through manifest names in order', async () => {
  const seen = [];
  const http = fakeHttp({ [raw('a/late', 'cordis.yml')]: { status: 200, text: 'x' } }, seen);
  const row = await auditRepo({ full_name: 'a/late' }, http);
  assert.equal(row.category, 'plugin');
  // short-circuits at cordis.yml, so only the two names before the hit were probed
  assert.deepEqual(seen, MANIFEST_NAMES.slice(0, 2).map((name) => raw('a/late', name)));
});

test('auditRepo: no full_name is unavailable, never a crash', async () => {
  const row = await auditRepo({ stargazers_count: 9 }, fakeHttp({}));
  assert.equal(row.category, 'unavailable');
});

test('fetchTopicRepos: stops after a short page and reports the topic total', async () => {
  const routes = Object.fromEntries([searchPage(1, [{ full_name: 'a/one' }], 1)]);
  const seen = [];
  const { total, repos } = await fetchTopicRepos({ http: fakeHttp(routes, seen) });
  assert.equal(total, 1);
  assert.equal(repos.length, 1);
  assert.equal(seen.length, 1);
});

test('fetchTopicRepos: walks pages until the total is reached', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ full_name: 'a/r' + i }));
  const routes = Object.fromEntries([
    searchPage(1, first, 150),
    searchPage(2, Array.from({ length: 50 }, (_, i) => ({ full_name: 'b/r' + i })), 150),
  ]);
  const { repos } = await fetchTopicRepos({ http: fakeHttp(routes) });
  assert.equal(repos.length, 150);
});

test('fetchTopicRepos: --max caps the scan', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ full_name: 'a/r' + i }));
  const routes = Object.fromEntries([searchPage(1, first, 500)]);
  const { repos } = await fetchTopicRepos({ http: fakeHttp(routes), max: 7 });
  assert.equal(repos.length, 7);
});

test('fetchTopicRepos: rate limit is a loud error, not an empty report', async () => {
  const http = fakeHttp({}, []);
  await assert.rejects(
    () => fetchTopicRepos({ http: async () => ({ status: 403, text: '{}' }) }),
    /rate limit/i,
  );
  assert.equal(typeof http, 'function');
});

test('runAudit: buckets categories and sorts offenders by stars', async () => {
  const items = [
    { full_name: 'big/pollution', stargazers_count: 41000, description: 'resume builder' },
    { full_name: 'small/pollution', stargazers_count: 12 },
    { full_name: 'real/plugin', stargazers_count: 40 },
    { full_name: 'nice/companion', stargazers_count: 5 },
  ];
  const routes = Object.fromEntries([
    searchPage(1, items, 4),
    [raw('real/plugin', 'cordis.patch.yml'), { status: 200, text: 'patch: []' }],
    [raw('nice/companion', 'readme.md'), { status: 200, text: 'for DeepSeek Harness' }],
  ]);
  const audit = await runAudit({ http: fakeHttp(routes) });
  assert.equal(audit.summary.plugin, 1);
  assert.equal(audit.summary.companion, 1);
  assert.equal(audit.summary['not-a-plugin'], 2);
  assert.deepEqual(audit.offenders.map((row) => row.full_name), ['big/pollution', 'small/pollution']);
});

test('renderReport: names the star ranking failure mode and the offenders', async () => {
  const audit = {
    scanned: 4,
    summary: { plugin: 1, companion: 1, 'not-a-plugin': 2, unavailable: 0 },
    offenders: [{ full_name: 'big/pollution', stars: 41000, evidence: 'README present, no DSH relationship' }],
    results: [],
  };
  const text = renderReport(audit, { generatedAt: 'T' });
  assert.match(text, /not-a-plugin\s+2/);
  assert.match(text, /41000 stars  big\/pollution/);
  assert.match(text, /sorts by stars/);
});

test('renderMarkdown: emits a verdict table, offenders first', async () => {
  const audit = {
    scanned: 2,
    summary: { plugin: 1, companion: 0, 'not-a-plugin': 1, unavailable: 0 },
    results: [
      { full_name: 'real/plugin', stars: 4, category: 'plugin', evidence: 'root manifest: cordis.patch.yml' },
      { full_name: 'bad/repo', stars: 900, category: 'not-a-plugin', evidence: 'no root manifest, no README' },
    ],
  };
  const md = renderMarkdown(audit, { generatedAt: 'T' });
  const rows = md.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| verdict') && !line.startsWith('| ---'));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /bad\/repo/);
  assert.match(rows[0], /https:\/\/github.com\/bad\/repo/);
});