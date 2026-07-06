# 03 - Polymarket Liquidity Matrix

## Goal

Measure whether providers perform differently on popular Polymarket markets versus long-tail markets.

Popularity changes the source landscape. High-volume markets usually have more coverage, more SEO pages, and more social discussion. Long-tail markets may require exact-source search or better recall.

## What This Teaches

- Whether a provider is useful beyond obvious high-volume markets.
- Whether high-volume markets create more duplicate results.
- Whether long-tail markets expose provider-specific source discovery.
- Whether cost per useful source changes with market popularity.

## Scope

This experiment evaluates provider behavior. Do not change provider defaults from this file alone.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/03-polymarket-liquidity-matrix/
```

Store outputs under:

```text
protoblocks/src/03-polymarket-liquidity-matrix/runs/<timestamp>/
```

## Dataset

Fetch active Polymarket events ordered by volume or liquidity.

Useful endpoint shapes:

```text
https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=100
https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume_24hr&ascending=true&limit=100
https://gamma-api.polymarket.com/events?active=true&closed=false&order=liquidity&ascending=false&limit=100
```

Build three buckets:

- `hot`: top-volume markets.
- `middle`: markets around the median of fetched volume.
- `long_tail`: low-volume markets with non-empty questions.

Minimum viable run:

- 20 markets per bucket.
- 4 providers.

Better run:

- 50 markets per bucket.
- All configured providers.
- Separate volume and liquidity buckets.

## Run

For each market, run:

```text
<market question> official source
```

Suggested provider run:

```sh
bun src/cli/main.ts research "<market question> official source" \
  --providers brave,exa,tavily,linkup,nimble,searchx \
  --max 10 \
  --fresh \
  --json
```

Record:

```ts
type Row = {
  caseId: string
  bucket: 'hot' | 'middle' | 'long_tail'
  volume24h?: number
  liquidity?: number
  provider: string
  totalSources: number
  uniqueContributed: number
  expectedSourceHit?: boolean
  topDomains: string[]
  overlapPct: number
  costUSD: number
  latencyMs: number
}
```

## Metrics

- Useful sources per bucket.
- Unique contribution rate per bucket.
- Provider overlap per bucket.
- Cost per useful source by bucket.
- Empty or low-result rate by bucket.
- Polymarket-page rate by bucket.

## Success Criteria

The experiment succeeds when it answers:

- Which provider degrades least on long-tail markets?
- Which provider adds unique sources only in hot markets?
- Are long-tail failures caused by no results, wrong results, or stale results?
- Does the cheapest provider remain useful on long-tail markets?

## What We Might Learn

- High-volume markets may make all providers look similar.
- Long-tail markets may reveal the real value of Exa, Tavily, Linkup, or Nimble.
- Some providers may return generic Polymarket pages when external evidence is sparse.
- SearchX or Brave may be cheap enough to keep even if long-tail quality is lower.

## Results Log

### 2026-06-14 - Codex - 20260614T011801Z-03-polymarket-liquidity-matrix-pilot

- Commit/worktree: uncommitted/no HEAD; repository files appeared untracked before run.
- Commands: `bun protoblocks/src/03-polymarket-liquidity-matrix/run-pilot.ts`; runner executed `WIDEBAND_DB='protoblocks/src/03-polymarket-liquidity-matrix/runs/20260614T011801Z-03-polymarket-liquidity-matrix-pilot/ledger.db' bun src/cli/main.ts providers --json` and six `research` calls with `--providers brave,jina,desearch,sailor,searchx --max 10 --fresh --json` (full command list in `protoblocks/src/03-polymarket-liquidity-matrix/runs/20260614T011801Z-03-polymarket-liquidity-matrix-pilot/notes.md`).
- Providers: Low-Cost First Pass: `brave,jina,desearch,sailor,searchx`.
- Dataset: 6 active Polymarket submarket questions, sampled 2 hot / 2 middle / 2 long_tail by local numeric `volume24hr` sort from Gamma snapshots; cases frozen in `cases.jsonl` before provider calls.
- Cost: $0.0015 reported.
- Key metrics: 30 provider rows; 25 ok, 5 timeout. Useful sources by bucket: hot 14/80, middle 6/88, long_tail 0/75. Provider useful sources: brave 11, desearch 6, sailor 3, jina 0, searchx 0. Long-tail useful sources: 0 across all providers.
- Interpretation: long-tail crypto interval markets returned plenty of sources, but mostly generic price pages, Polymarket pages, or off-target crypto pages; failures were wrong-result failures more than empty-result failures. Jina timed out on 5/6 pilot rows.
- Follow-up: rerun with stricter query templates that include the expected resolution-source host, and compare against a freshness/domain-capable provider set before judging long-tail provider value.
- Project change justified: needs_more_data.
