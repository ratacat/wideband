# 07 - Cost Per Useful Source

## Goal

Measure provider value as cost per accepted useful source, not cost per raw result.

Raw result count rewards noisy providers. This experiment adds a lightweight usefulness judgment so cost comparisons reflect research value.

## What This Teaches

- Which providers produce useful sources cheaply.
- Which providers return many irrelevant or duplicate sources.
- Which providers justify paid calls.
- Whether `scan` or `research` mode has better economics by provider.

## Scope

This is an offline evaluation. Do not change cost models or default budgets from one run.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/07-cost-per-useful-source/
```

Store outputs under:

```text
protoblocks/src/07-cost-per-useful-source/runs/<timestamp>/
```

## Dataset

Use 100 cases:

- 40 Polymarket.
- 20 current news.
- 20 official-domain lookups.
- 10 long-tail niche topics.
- 10 known-answer source-discovery prompts.

Include expected domains when possible.

## Usefulness Labels

Start with a deterministic heuristic, then manually audit a sample.

Accept a source if at least one condition holds:

- URL host matches an expected domain.
- Title or snippet contains a core entity from the query.
- Source is not a search result page, social aggregator, or duplicate summary.
- For Polymarket cases, source is not merely the Polymarket event page unless the case asks for the market page.

Use this label shape:

```ts
type Label = {
  sourceId: string
  useful: boolean
  reason: 'expected_domain' | 'entity_match' | 'manual_accept' | 'duplicate' | 'off_topic' | 'aggregator' | 'polymarket_page'
}
```

## Run

Run both modes when supported:

```sh
bun src/cli/main.ts scan "<query>" --providers <provider> --max 10 --fresh --json
bun src/cli/main.ts research "<query>" --providers <provider> --max 10 --fresh --json
```

Record one row per `(case, provider, mode)`:

```ts
type Row = {
  caseId: string
  provider: string
  mode: 'scan' | 'research'
  totalSources: number
  usefulSources: number
  uniqueUsefulSources: number
  costUSD: number
  latencyMs: number
  costPerUseful: number | null
  costPerUniqueUseful: number | null
}
```

## Manual Audit

Manually audit at least:

- 10 accepted sources.
- 10 rejected sources.
- 5 sources from each provider.

Record disagreements with the heuristic. If the heuristic is poor, report that as a result rather than polishing it endlessly.

## Metrics

- Cost per useful source.
- Cost per unique useful source.
- Useful-source rate.
- Useful-source latency.
- Paid-provider lift over free providers.
- `research` lift over `scan`.

## Success Criteria

The experiment succeeds when it produces:

- Provider ranking by cost per useful source.
- Provider ranking by cost per unique useful source.
- A note on heuristic precision from manual audit.
- Examples of expensive-but-useful and cheap-but-noisy providers.

## What We Might Learn

- Some providers may look strong by source count but weak by usefulness.
- `research` mode may be worth paying for only on full-content providers.
- Free providers may be strong first-pass filters.
- Cost per unique useful source may be the best long-term provider metric.

## Results Log

### 2026-06-14 - Codex - 20260614T012338Z-07-cost-per-useful-source-pilot

- Commit/worktree: no commit in this checkout; uncommitted/untracked workspace.
- Commands: `bun protoblocks/src/07-cost-per-useful-source/run-pilot.ts`; provider inventory and all 35 provider calls are listed in `protoblocks/src/07-cost-per-useful-source/runs/20260614T012338Z-07-cost-per-useful-source-pilot/notes.md` and `summary.json`.
- Providers: scan mode with Low-Cost First Pass `brave,jina,desearch,sailor,searchx`; added paid comparison `exa,tavily`. Exact set: `brave,jina,desearch,sailor,searchx,exa,tavily`.
- Dataset: 5 fixed pilot cases, sampled before provider calls: 2 Polymarket-style resolution-source prompts, 1 current-news prompt, 1 official-domain prompt, 1 known-answer/long-tail prompt.
- Cost: `$0.06125` across 35 scan calls.
- Key metrics:
  - Total sources: 344; heuristic useful sources: 249; row-level unique useful sources: 249; heuristic cost/useful: `$0.000246`.
  - Cost per unique useful by provider: `searchx $0`, `brave $0`, `jina $0`, `sailor $0`, `desearch $0.000031`, `tavily $0.000641`, `exa $0.000745`.
  - Useful-source rate by provider: `exa 0.940`, `searchx 0.833`, `desearch 0.800`, `brave 0.780`, `tavily 0.780`, `jina 0.776`, `sailor 0.128`.
  - Manual audit: 35 labels, 24 agreements, 11 disagreements; precision on heuristic-accepted audited sources was 16/27 (`0.593`).
- Interpretation: official-domain hits were mostly reliable, but the heuristic over-accepted generic `entity_match` pages, market wrappers, and broad expected-domain pages. Treat provider rankings as pilot/heuristic-biased, especially for `searchx` and `sailor`.
- Follow-up: tighten labels before full run: require expected URL/path or stronger source-type checks for official-domain prompts, classify prediction-market wrapper domains as D, and run a body-opened audit sample.
- Project change justified: `needs_more_data`.
