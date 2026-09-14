#!/usr/bin/env node
// Render a short markdown summary of a dsh-topic-audit JSON payload.
// Used by the nightly publish workflow to fill release notes.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function renderSummary(payload, { top = 15 } = {}) {
  const lines = [];
  lines.push('Nightly audit of the `dsh-plugin` topic.');
  lines.push('');
  lines.push('Scanned ' + payload.scanned + ' of ' + payload.total + ' repos tagged `dsh-plugin`: **' + payload.summary.plugin + ' plugin**, **' + payload.summary.companion + ' companion**, **' + payload.summary['not-a-plugin'] + ' not-a-plugin**.');
  lines.push('');
  const offenders = payload.results
    .filter((row) => row.category === 'not-a-plugin')
    .sort((a, b) => b.stars - a.stars)
    .slice(0, top);
  if (offenders.length) {
    lines.push('| not-a-plugin repo | stars | evidence |');
    lines.push('| --- | --- | --- |');
    for (const row of offenders) {
      lines.push('| [' + row.full_name + '](https://github.com/' + row.full_name + ') | ' + row.stars + ' | ' + row.evidence + ' |');
    }
    lines.push('');
  }
  lines.push('Reproduce with `node topic-audit.mjs --bands --json --out audit.json`; rules and limits are in the README.');
  return lines.join('\n') + '\n';
}

export function main(argv) {
  const input = argv[2];
  const output = argv[3];
  if (!input) throw new Error('usage: node scripts/summary.mjs <audit.json> [summary.md]');
  const payload = JSON.parse(readFileSync(input, 'utf8'));
  const text = renderSummary(payload);
  if (output) writeFileSync(output, text, 'utf8');
  else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv));
  } catch (error) {
    process.stderr.write('summary: ' + error.message + '\n');
    process.exit(1);
  }
}