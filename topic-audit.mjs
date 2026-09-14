#!/usr/bin/env node
// dsh-topic-audit — audit the GitHub `dsh-plugin` topic: separate real DSH plugins
// from plugin-adjacent companion tools and from repos that only borrowed the topic.
//
// Zero dependencies. Pure ESM. Node >= 18 (global fetch).
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.3.0';
export const SCHEMA = 'dsh-topic-audit/v1';
export const TOPIC = 'dsh-plugin';
export const SEARCH_WINDOW = 1000; // GitHub search returns at most 1000 results per query

// A real DSH plugin ships a cordis bundle manifest at the repo root and installs
// with `dsh plugin add`. These are the root-level names we accept.
export const MANIFEST_NAMES = ['cordis.patch.yml', 'cordis.yml', 'cordis.patch.yaml', 'cordis.yaml'];
// raw.githubusercontent.com is case-sensitive, so try the common spellings.
export const README_NAMES = ['readme.md', 'README.md', 'README.zh.md', 'readme.zh.md'];

export const DSH_MENTION = /deep[\s-]?seek[\s-]?harness/i;
export const INSTALL_HINT = /dsh plugin add/i;

// Star bands for --bands mode. The topic is far larger than one search query can
// return, so full coverage means slicing it by star count and deduplicating.
export const STAR_BANDS = [
  '>=10000', '5000..9999', '2000..4999', '1000..1999', '500..999', '200..499',
  '100..199', '50..99', '20..49', '10..19', '5..9', '2..4', '1', '0',
];

export function defaultHttp(url, headers) {
  return fetch(url, { headers: headers || {}, redirect: 'follow' })
    .then(async (res) => ({ status: res.status, text: res.status === 200 ? await res.text() : '' }))
    .catch(() => ({ status: 0, text: '' }));
}

function rawUrl(fullName, name) {
  return 'https://raw.githubusercontent.com/' + fullName + '/HEAD/' + name;
}

export function searchUrl(query, page) {
  return 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) +
    '&sort=stars&order=desc&per_page=100&page=' + page;
}

function headersFor(token) {
  return token
    ? { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
    : { Accept: 'application/vnd.github+json' };
}

async function firstHit(fullName, names, http) {
  for (const name of names) {
    const res = await http(rawUrl(fullName, name));
    if (res.status === 200 && res.text) return { name, text: res.text };
  }
  return null;
}

// Pure verdict function: everything the audit decides lives here, so tests do not
// need the network.
export function classify({ manifest, readme }) {
  if (manifest) return { category: 'plugin', evidence: 'root manifest: ' + manifest.name };
  if (readme) {
    if (INSTALL_HINT.test(readme.text)) {
      return { category: 'companion', evidence: 'installs via dsh plugin add (no root manifest)' };
    }
    if (DSH_MENTION.test(readme.text)) {
      return { category: 'companion', evidence: 'README references DeepSeek Harness' };
    }
    return { category: 'not-a-plugin', evidence: 'README present, no DSH relationship' };
  }
  return { category: 'not-a-plugin', evidence: 'no root manifest, no README' };
}

export async function auditRepo(repo, http) {
  if (!repo || !repo.full_name) {
    return { full_name: '(unresolvable)', stars: 0, description: '', archived: false, category: 'unavailable', evidence: 'repo entry has no full_name' };
  }
  const manifest = await firstHit(repo.full_name, MANIFEST_NAMES, http);
  const readme = manifest ? null : await firstHit(repo.full_name, README_NAMES, http);
  const verdict = classify({ manifest, readme });
  return {
    full_name: repo.full_name,
    stars: repo.stargazers_count || 0,
    description: repo.description || '',
    archived: !!repo.archived,
    category: verdict.category,
    evidence: verdict.evidence,
  };
}

export async function fetchQuery(query, { http = defaultHttp, token = '', max = SEARCH_WINDOW, onPage = null } = {}) {
  const repos = [];
  let total = 0;
  let capped = false;
  for (let page = 1; page <= 10; page += 1) {
    const res = await http(searchUrl(query, page), headersFor(token));
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub search rate limit hit (status ' + res.status + '). Set GITHUB_TOKEN or GH_TOKEN to raise the limit.');
    }
    if (res.status !== 200) throw new Error('GitHub search failed with status ' + res.status + ' for ' + query);
    const json = JSON.parse(res.text);
    total = json.total_count || 0;
    const items = json.items || [];
    if (onPage) onPage(page, items.length, total);
    for (const item of items) {
      if (repos.length >= max) { capped = true; break; }
      repos.push(item);
    }
    if (repos.length >= max) { capped = true; break; }
    if (items.length < 100) break;
    if (repos.length >= total) break;
  }
  return { total, repos, capped };
}

export function topicTotal(opts = {}) {
  return fetchQuery('topic:' + TOPIC, { ...opts, max: 1 }).then((res) => res.total);
}

export function fetchTopicRepos(opts = {}) {
  return fetchQuery('topic:' + TOPIC, opts);
}

function dateNum(text) {
  return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)));
}

function dateText(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// A star band can exceed the 1000-result window on its own (the 0-star band holds
// thousands of repos). Splitting the band by creation date, recursively, is how a
// nightly job reaches the long tail. A window that is still capped at one day is
// reported as truncated rather than silently dropped.
export async function enumerateFull({ http = defaultHttp, token = '', bands = STAR_BANDS, from = '2008-01-01', to = today(), onSegment = null, maxQueries = 4000 } = {}) {
  const seen = new Set();
  const repos = [];
  const coverage = [];
  let queries = 0;
  for (const band of bands) {
    const stack = [{ from, to }];
    let added = 0;
    let found = 0;
    let windows = 0;
    let truncated = false;
    while (stack.length && queries < maxQueries) {
      const seg = stack.pop();
      queries += 1;
      const query = 'topic:' + TOPIC + ' stars:' + band + ' created:' + seg.from + '..' + seg.to;
      const res = await fetchQuery(query, { http, token });
      found += res.repos.length;
      windows += 1;
      for (const item of res.repos) {
        if (!item || !item.full_name || seen.has(item.full_name)) continue;
        seen.add(item.full_name);
        repos.push(item);
        added += 1;
      }
      if (res.capped) {
        const start = dateNum(seg.from);
        const end = dateNum(seg.to);
        const mid = dateText(Math.floor((start + end) / 2));
        if (mid === seg.from) {
          truncated = true;
        } else {
          stack.push({ from: seg.from, to: mid });
          stack.push({ from: dateText(dateNum(mid) + 86400000), to: seg.to });
        }
      }
      if (onSegment) onSegment(band, seg.from, seg.to, res.repos.length, res.capped);
    }
    coverage.push({ band, added, found, windows, truncated, hitQueryLimit: queries >= maxQueries });
  }
  return { repos, coverage, queries };
}

export async function fetchTopicByBands({ http = defaultHttp, token = '', bands = STAR_BANDS, onBand = null } = {}) {
  const seen = new Set();
  const repos = [];
  const coverage = [];
  for (const band of bands) {
    const res = await fetchQuery('topic:' + TOPIC + ' stars:' + band, { http, token });
    let added = 0;
    for (const item of res.repos) {
      if (!item || !item.full_name || seen.has(item.full_name)) continue;
      seen.add(item.full_name);
      repos.push(item);
      added += 1;
    }
    coverage.push({ band, found: res.repos.length, added, total: res.total, capped: res.capped });
    if (onBand) onBand(band, added, res.total, res.capped);
  }
  return { repos, coverage };
}

export async function runAudit({ http = defaultHttp, token = '', max = SEARCH_WINDOW, concurrency = 10, onPage = null, bands = false, full = false, onBand = null, onSegment = null, maxQueries = 4000, from = undefined, to = undefined } = {}) {
  let total;
  let repos;
  let coverage = null;
  let queries = null;
  if (full || bands) {
    total = await topicTotal({ http, token });
  }
  if (full) {
    const complete = await enumerateFull({ http, token, onSegment, maxQueries, from, to });
    repos = complete.repos;
    coverage = complete.coverage;
    queries = complete.queries;
  } else if (bands) {
    const sliced = await fetchTopicByBands({ http, token, onBand });
    repos = sliced.repos;
    coverage = sliced.coverage;
  } else {
    const res = await fetchTopicRepos({ http, token, max, onPage });
    total = res.total;
    repos = res.repos;
  }
  const results = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const index = next;
      next += 1;
      results[index] = await auditRepo(repos[index], http);
    }
  };
  const width = Math.max(1, Math.min(concurrency, repos.length));
  await Promise.all(Array.from({ length: width }, worker));
  const summary = { plugin: 0, companion: 0, 'not-a-plugin': 0, unavailable: 0 };
  for (const row of results) summary[row.category] = (summary[row.category] || 0) + 1;
  const offenders = results
    .filter((row) => row.category === 'not-a-plugin')
    .sort((a, b) => b.stars - a.stars);
  return { total, scanned: results.length, summary, offenders, coverage, queries, results };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= (width || 0) ? text : ' '.repeat(width - text.length) + text;
}

export function renderReport(audit, { generatedAt = new Date().toISOString(), top = 15 } = {}) {
  const lines = [];
  lines.push('dsh-topic-audit v' + VERSION);
  lines.push('audited ' + audit.scanned + ' repos tagged ' + TOPIC + ' (' + generatedAt + ')');
  lines.push('');
  lines.push('  plugin        ' + pad(audit.summary.plugin, 4) + '  root cordis manifest present');
  lines.push('  companion     ' + pad(audit.summary.companion, 4) + '  DSH-ecosystem tool, no root bundle');
  lines.push('  not-a-plugin  ' + pad(audit.summary['not-a-plugin'], 4) + '  no manifest, no DSH relationship');
  if (audit.summary.unavailable) lines.push('  unavailable   ' + pad(audit.summary.unavailable, 4) + '  repo entry not resolvable');
  lines.push('');
  if (audit.coverage) {
    lines.push('coverage by star band (deduplicated):');
    for (const row of audit.coverage) {
      const extra = [];
      if (row.windows) extra.push(row.windows + ' windows');
      if (row.capped) extra.push('capped at the 1000-result search window');
      if (row.truncated) extra.push('still capped at a single day - truncated');
      lines.push('  ' + pad(row.band, 12) + ' ' + pad(row.added, 5) + ' new of ' + pad(row.found, 5) + ' found' + (extra.length ? '  [' + extra.join('; ') + ']' : ''));
    }
    lines.push('');
  } else if (audit.total > audit.scanned) {
    lines.push('note: the topic holds ' + audit.total + ' repos and the GitHub search API returns at most');
    lines.push('      1000 results per query, so this scan covered the top ' + audit.scanned + ' by stars.');
    lines.push('      Re-run with --bands to walk star ranges instead.');
    lines.push('');
  }
  const topRows = audit.offenders.slice(0, top);
  if (topRows.length) {
    lines.push('top ' + topRows.length + ' not-a-plugin by stars (the topic sorts by stars, so these are what users see first):');
    for (const row of topRows) {
      lines.push('  ' + pad(row.stars, 7) + ' stars  ' + row.full_name + '  [' + row.evidence + ']');
    }
  } else {
    lines.push('no not-a-plugin repos found.');
  }
  return lines.join('\n');
}

export function renderMarkdown(audit, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [];
  lines.push('# dsh-plugin topic audit');
  lines.push('');
  lines.push('Generated ' + generatedAt + ' by dsh-topic-audit v' + VERSION + '.');
  lines.push('');
  lines.push('Scanned **' + audit.scanned + '** repos tagged `dsh-plugin` (topic total **' + audit.total + '**): **' + audit.summary.plugin + '** plugins, **' + audit.summary.companion + '** companions, **' + audit.summary['not-a-plugin'] + '** not-a-plugin.');
  lines.push('');
  lines.push('| verdict | repo | stars | evidence |');
  lines.push('| --- | --- | --- | --- |');
  const order = { 'not-a-plugin': 0, unavailable: 1, companion: 2, plugin: 3 };
  const rows = audit.results.slice().sort((a, b) => (order[a.category] - order[b.category]) || (b.stars - a.stars));
  for (const row of rows) {
    const name = row.category === 'plugin' ? row.full_name : '[' + row.full_name + '](https://github.com/' + row.full_name + ')';
    lines.push('| ' + row.category + ' | ' + name + ' | ' + row.stars + ' | ' + row.evidence + ' |');
  }
  return lines.join('\n');
}

const USAGE = [
  'dsh-topic-audit — audit the GitHub dsh-plugin topic',
  '',
  'Usage:',
  '  npx dsh-topic-audit [options]',
  '  node topic-audit.mjs [options]',
  '',
  'Options:',
  '  --bands           walk star ranges instead of one query (needed because the',
  '                    topic is larger than the 1000-result search window)',
  '  --full            like --bands, but recursively splits any band that still hits',
  '                    the window by creation date, so the long tail is reachable',
  '  --json            print a JSON payload instead of a text report',
  '  --out <file>      also write the report (markdown, or JSON with --json) to <file>',
  '  --max <n>         cap the single-query scan (default 1000, the API window; ignored with --bands)',
  '  --concurrency <n> parallel repo checks (default 10)',
  '  --strict          exit 1 when any scanned repo is not-a-plugin',
  '  --help            show this help',
  '',
  'Auth: set GITHUB_TOKEN or GH_TOKEN to lift the unauthenticated search rate limit.',
].join('\n');

export async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const wantJson = args.includes('--json');
  const strict = args.includes('--strict');
  const bands = args.includes('--bands');
  const full = args.includes('--full');
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const maxIndex = args.indexOf('--max');
  const max = maxIndex >= 0 ? Number(args[maxIndex + 1]) : SEARCH_WINDOW;
  if (!Number.isFinite(max) || max <= 0) throw new Error('--max needs a positive number');
  const concurrencyIndex = args.indexOf('--concurrency');
  const concurrency = concurrencyIndex >= 0 ? Number(args[concurrencyIndex + 1]) : 10;
  if (!Number.isFinite(concurrency) || concurrency <= 0) throw new Error('--concurrency needs a positive number');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const audit = await runAudit({
    token,
    max,
    concurrency,
    bands,
    full,
    onPage: bands ? null : (page, count, total) => process.stderr.write('  page ' + page + ': ' + count + ' repos (topic total ' + total + ')\n'),
    onBand: bands && !full ? (band, added, total, capped) => process.stderr.write('  band stars:' + band + ': +' + added + ' new of ' + total + ' found' + (capped ? ' (capped)' : '') + '\n') : null,
    onSegment: full ? (band, from, to, found, capped) => process.stderr.write('  band ' + band + ' ' + from + '..' + to + ': ' + found + (capped ? ' (splitting)' : '') + '\n') : null,
  });
  const generatedAt = new Date().toISOString();
  const payload = { schema: SCHEMA, generatedAt, topic: TOPIC, total: audit.total, scanned: audit.scanned, queries: audit.queries, summary: audit.summary, coverage: audit.coverage, results: audit.results };
  if (outPath) {
    writeFileSync(outPath, wantJson ? JSON.stringify(payload, null, 2) + '\n' : renderMarkdown(audit, { generatedAt }) + '\n', 'utf8');
  }
  if (wantJson) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write(renderReport(audit, { generatedAt }) + '\n');
  if (strict && audit.summary['not-a-plugin'] > 0) return 1;
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write('dsh-topic-audit: ' + error.message + '\n');
      process.exit(1);
    });
}
