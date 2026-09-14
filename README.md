# dsh-topic-audit

The [`dsh-plugin`](https://github.com/topics/dsh-plugin) GitHub topic is the de-facto registry for DeepSeek Harness plugins. It is also sortable by stars, so a repo with no relationship to DSH can borrow the topic and outrank every real plugin on the page.

This tool audits the topic mechanically and separates three populations:

| verdict | meaning |
| --- | --- |
| `plugin` | ships a cordis bundle manifest at the repo root (`cordis.patch.yml` / `cordis.yml` / `.yaml`) — installable with `dsh plugin add` |
| `companion` | no root manifest, but the README references DeepSeek Harness or documents `dsh plugin add` — a plugin-adjacent tool that is legitimately part of the ecosystem |
| `not-a-plugin` | neither: no manifest, no DSH relationship in the README |

The `companion` bucket exists on purpose. Real DSH plugins and ecosystem tooling (standalone CLIs, scaffolder, diagnostics) are different things, and an audit that drops the second group into the same bucket as a resume builder with a `dsh-plugin` sticker is not useful to anyone.

## Coverage: why one query is not enough

On the first run the topic reported **14,846** repos. The GitHub search API returns at most **1,000** results for any single query, so a single-query run audits the top 1,000 by stars — exactly the slice the topic page shows first, and therefore the slice that determines what a visitor sees.

`--bands` does not finish the job by itself. The three lowest bands are all larger than one window: 2-4 stars holds **2,755** repos, 1 star holds **3,503**, and 0 stars holds **6,581** — 12,839 repos that a star-band walk still cannot see in full. `--full` handles that by splitting any capped band by creation date and recursing until every window fits, flagging the rare window that is still capped at a single day:

```sh
node topic-audit.mjs --full --json --out audit.json
```

A band or window that is still capped is flagged in the output, so incomplete coverage is visible rather than silent. `--bands` remains the cheap first pass.

## Baseline

First run, top 1,000 repos by stars (topic total 14,846): **580** `plugin`, **323** `companion`, **97** `not-a-plugin`. Five of the ten highest-starred repos carrying the topic are not DSH plugins at all, including a 42k-star resume builder and a 72k-star general agent framework; those 97 repos hold 302k stars between them, more than the 580 real plugins combined (70k). The verdicts are reproducible from the rules below, and every row carries its evidence string.

## Usage

No install, no dependencies — clone and run:

```sh
git clone https://github.com/ciceroyang/dsh-topic-audit
cd dsh-topic-audit

node topic-audit.mjs                              # human-readable report
node topic-audit.mjs --json --out audit.json      # machine-readable, for a nightly job or a directory ingester
node topic-audit.mjs --strict                     # exit 1 when the topic contains a not-a-plugin
node topic-audit.mjs --full --json --out audit.json   # walk the long tail
```

An npm package is not published yet (publishing needs credentials this project does not have), so `npx dsh-topic-audit` does not resolve today. The npm name is free; if you want to publish it yourself, `npm publish` works from the clone as-is.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) to lift the unauthenticated search rate limit. The per-repo checks use `raw.githubusercontent.com`, which is not part of the API rate limit.

## Nightly index

A scheduled workflow publishes the audit as a rolling release asset, so a directory ingester can fetch a verified list without running anything:

- JSON: `https://github.com/ciceroyang/dsh-topic-audit/releases/download/latest/audit.json`
- counts and the current top offenders: the notes on `https://github.com/ciceroyang/dsh-topic-audit/releases/tag/latest`

The asset is regenerated from a clean `--bands` run each night, and anyone can reproduce it with the same command and diff. The rolling `latest` tag is deliberate: the value is a current list plus a verifiable recipe, not an authoritative snapshot.

## In CI

The repository is also a composite action, so a nightly job is three lines:

```yaml
- uses: ciceroyang/dsh-topic-audit@main
  with:
    args: --json --out audit.json
```

The action injects the workflow token (lifting the search rate limit) and exposes the report path as the `report` output. Add `--strict` to `args` to fail the job when the topic contains a `not-a-plugin`; add `--bands` or `--full` when the job needs more than the top 1,000 by stars.

The default Actions token has a much smaller search quota than a personal token. The audit retries a rate-limited query with backoff (2s, 8s, 20s) and accepts `--delay`; the nightly workflow that ships with this repo uses `--delay 2500`, which is enough for the 14-band walk. For heavier runs, pass a personal token through the action `token` input.

## Options

| flag | effect |
| --- | --- |
| `--bands` | walk star ranges instead of one query, needed because the topic is larger than the 1000-result search window |
| `--full` | like `--bands`, but recursively splits any band that still hits the window by creation date, so the low-star long tail is reachable |
| `--json` | print a JSON payload instead of the text report |
| `--concurrency <n>` | parallel repo checks (default 10) |
| `--delay <ms>` | wait between search queries (default 0; CI tokens usually need 2000 or more) |
| `--out <file>` | also write the report to a file (markdown, or JSON with `--json`) |
| `--max <n>` | scan at most n repos (default 1000, the search API cap) |
| `--strict` | exit 1 when any scanned repo is `not-a-plugin` |
| `--help` | usage |

## JSON shape

```json
{
  "schema": "dsh-topic-audit/v1",
  "generatedAt": "2026-08-18T15:00:00.000Z",
  "topic": "dsh-plugin",
  "total": 183,
  "scanned": 183,
  "summary": { "plugin": 121, "companion": 19, "not-a-plugin": 43, "unavailable": 0 },
  "results": [
    { "full_name": "owner/repo", "stars": 41234, "description": "...", "archived": false, "category": "not-a-plugin", "evidence": "README present, no DSH relationship" }
  ]
}
```

## The rules, stated precisely

1. `plugin` — a root-level file named `cordis.patch.yml`, `cordis.yml`, `cordis.patch.yaml` or `cordis.yaml` loads (HTTP 200, non-empty).
2. Otherwise a root-level README is fetched (`readme.md`, `README.md`, `README.zh.md`, `readme.zh.md`, in that order). If it contains `dsh plugin add`, or matches `deep[ -]?seek[ -]?harness` case-insensitively, the verdict is `companion`.
3. Otherwise the verdict is `not-a-plugin`.

The audit prints no accusations beyond what those rules produce, and every row carries its `evidence` string so a human can check the call without re-running the audit.

## Limits (read before quoting a number)

- Root manifest only. A bundle kept in a subdirectory and never mentioned in the README is reported `not-a-plugin`. The repair for that is one line in the README.
- The mention test is the product name `DeepSeek Harness`, not the word `DeepSeek`. A repo that merely offers a DeepSeek API key option does not pass, which is intentional: that was the exact false positive found on a 41k-star repo.
- `raw.githubusercontent.com` is case-sensitive, so the README probe tries the common spellings. An unusual README filename reads as missing.
- The search API caps a query at 1000 repos, and the topic is much larger than that: a single-query run covers the top 1000 by stars and prints a note saying so. `--bands` walks star ranges (`stars:>=10000` down to `stars:0`) and deduplicates, which is the only way to approach full coverage.
- The verdict is about the `dsh-plugin` topic claim, not about repo quality.

## Related

- [dsh-doctor](https://github.com/ciceroyang/dsh-doctor) — offline environment, profile and session-log diagnostics for a single machine.
- [dsh-plugin-starter](https://github.com/ciceroyang/dsh-plugin-starter) — scaffold a plugin that passes this audit by construction.
- [dsh-report-studio](https://github.com/ciceroyang/dsh-report-studio) — session to shareable reports.

## License

MIT. Maintained by [@ciceroyang](https://github.com/ciceroyang). If this saves you an afternoon of topic archaeology, [Afdian](https://afdian.com/a/cicero) keeps the tooling alive.