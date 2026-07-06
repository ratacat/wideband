# 04 - Polymarket Query Phrasing Sensitivity

## Goal

Measure how much provider output changes when the same Polymarket market uses different query phrasings.

This experiment tests whether poor results come from provider limitations or from weak query construction.

## What This Teaches

- Which providers are sensitive to exact wording.
- Which query templates find official sources.
- Which templates increase duplicate or low-authority results.
- Whether wideband should later support offline query-template recommendations.

## Scope

Do not add query expansion or rewriting to wideband from this protoblock. Keep the output as evidence.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/04-polymarket-query-phrasing-sensitivity/
```

Store outputs under:

```text
protoblocks/src/04-polymarket-query-phrasing-sensitivity/runs/<timestamp>/
```

## Dataset

Use 30-50 markets from Polymarket. Prefer markets with `resolutionSource`, because that provides a known target.

Each case should include:

- Market question.
- Slug.
- Category, if available.
- `resolutionSource`, if available.
- End date, if available.

## Query Templates

Run each market through these templates:

```ts
const templates = {
  raw: (q: string) => q,
  official: (q: string) => `${q} official source`,
  resolution: (q: string) => `${q} resolution criteria source`,
  evidence: (q: string) => `${q} latest evidence`,
  domain: (q: string, source?: string) => {
    if (!source) return `${q} official source`
    const host = new URL(source).hostname.replace(/^www\./, '')
    return `${q} ${host}`
  },
}
```

## Run

For each `(market, template, provider)`, run:

```sh
bun src/cli/main.ts research "<rendered query>" \
  --providers <provider> \
  --max 10 \
  --fresh \
  --json
```

Record:

```ts
type Row = {
  caseId: string
  provider: string
  template: string
  renderedQuery: string
  totalSources: number
  expectedSourceHit?: boolean
  firstExpectedRank?: number
  uniqueDomains: number
  polymarketHits: number
  costUSD: number
  latencyMs: number
}
```

## Metrics

- Expected-source recall by template.
- Average result count by template.
- Unique domains by template.
- Polymarket-page rate by template.
- Provider sensitivity score: result-set Jaccard distance between templates.
- Cost per expected-source hit by template.

## Success Criteria

The experiment succeeds when it identifies:

- Best query template per provider.
- Best query template overall.
- Templates that consistently hurt results.
- Markets where no phrasing helps.

## What We Might Learn

- `official source` may improve resolution-source recall.
- `latest evidence` may improve news-like markets but hurt stable official-source markets.
- Host-in-query templates may help when `resolutionSource` exists.
- Some providers may ignore subtle query changes, while others change drastically.

## Results Log

### 2026-06-14 - Codex - 20260614T011748Z-04-polymarket-query-phrasing-sensitivity-pilot

- Commit/worktree: no commits in repo; working tree already untracked
- Commands: `RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-04-polymarket-query-phrasing-sensitivity-pilot"; RUN_DIR="protoblocks/src/04-polymarket-query-phrasing-sensitivity/runs/$RUN_ID"; mkdir -p "$RUN_DIR"`; `bun src/cli/main.ts providers --json > "$RUN_DIR/providers.json"`; `bun protoblocks/src/04-polymarket-query-phrasing-sensitivity/pilot.ts sample --run-dir "$RUN_DIR" --case-cap 3`; `WIDEBAND_DB="$RUN_DIR/ledger.db" bun protoblocks/src/04-polymarket-query-phrasing-sensitivity/pilot.ts execute --run-id "$RUN_ID" --run-dir "$RUN_DIR" --providers brave,jina,desearch,sailor,searchx`; `bun protoblocks/src/04-polymarket-query-phrasing-sensitivity/pilot.ts summarize --run-id "$RUN_ID" --run-dir "$RUN_DIR" --providers brave,jina,desearch,sailor,searchx`
- Providers: Low-Cost First Pass: `brave,jina,desearch,sailor,searchx`
- Dataset: 3 closed Polymarket Gamma markets, first API-ordered cases with HTTP(S) `resolutionSource`; active sampled markets did not expose URL-valued `resolutionSource`
- Cost: $0.00375 reported/estimated
- Key metrics: 75 rows, 68 ok calls, 7 Jina timeouts. Expected-source host recall by template: `domain` 9/15 (60.0%), `official` 5/15 (33.3%), `raw` 4/15 (26.7%), `evidence` 4/15 (26.7%), `resolution` 3/15 (20.0%). Exact URL hits: `domain` 3, all others 0. Provider expected-source hits: `brave` 8/15, `desearch` 7/15, `jina` 5/15, `sailor` 5/15, `searchx` 0/15.
- Interpretation: Adding the expected host to the query was the clearest pilot win. Generic `resolution criteria source` underperformed `official source`; `searchx` returned full result sets but missed expected hosts; `sailor` appeared insensitive to phrasing.
- Follow-up: Full run should use more recent markets and separate exact URL, expected host, and official-domain hits more explicitly.
- Project change justified: needs_more_data
