# 06 - Leave-One-Provider-Out

## Goal

Measure each provider's marginal value by comparing all-provider results with all-provider-minus-one results.

This experiment answers: "What do we lose if this provider is not included?"

## What This Teaches

- Which providers contribute unique sources.
- Which providers mostly duplicate cheaper providers.
- Which providers improve quality despite adding few raw sources.
- Which providers slow or cost more than their marginal value justifies.

## Scope

Do not remove providers based on one run. Use this experiment to create evidence for later decisions.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/06-leave-one-provider-out/
```

Store outputs under:

```text
protoblocks/src/06-leave-one-provider-out/runs/<timestamp>/
```

## Dataset

Use a mixed benchmark set:

- 50 Polymarket cases.
- 20 general current-news cases.
- 20 official-domain cases.
- 10 long-tail obscure cases.

Each case should include tags:

```ts
type Case = {
  id: string
  q: string
  tags: string[]
  expectedDomains?: string[]
}
```

## Run

For each case:

1. Run all configured providers.
2. Run the same query once per provider excluded.

Example:

```sh
bun src/cli/main.ts research "<query>" \
  --providers brave,exa,tavily,linkup,nimble,searchx \
  --max 10 \
  --fresh \
  --json
```

Then:

```sh
bun src/cli/main.ts research "<query>" \
  --providers exa,tavily,linkup,nimble,searchx \
  --max 10 \
  --fresh \
  --json
```

Use the same provider list order across the experiment.

## Suggested Diff Logic

```ts
function ids(result: { sources: { id: string }[] }) {
  return new Set(result.sources.map((s) => s.id))
}

function lostSources(baseline: { sources: { id: string }[] }, minusOne: { sources: { id: string }[] }) {
  const after = ids(minusOne)
  return baseline.sources.filter((source) => !after.has(source.id))
}
```

Record:

```ts
type Row = {
  caseId: string
  excludedProvider: string
  baselineSources: number
  minusSources: number
  lostSourceCount: number
  lostExpectedDomainCount?: number
  costSavedUSD: number
  latencySavedMs: number
  lostUrls: string[]
}
```

## Metrics

- Lost unique sources per excluded provider.
- Lost expected-domain hits per excluded provider.
- Cost saved per lost useful source.
- Latency saved per lost useful source.
- Categories where each provider matters most.

## Success Criteria

The experiment succeeds when each provider has:

- Marginal source contribution.
- Marginal expected-domain contribution.
- Cost saved when excluded.
- Example URLs that only appeared with that provider included.

## What We Might Learn

- A provider with low raw contribution may still be valuable for official domains.
- A cheap provider may add enough recall to justify always including it.
- A paid provider may duplicate cheaper providers for common topics but matter for long-tail cases.
- Provider value may depend more on query class than global quality.

## Results Log

### 2026-06-14 - Codex - 20260614T011754Z-06-leave-one-provider-out-pilot

- Commit/worktree: uncommitted/no HEAD
- Commands: `bun protoblocks/src/06-leave-one-provider-out/run-pilot.ts`; full command list in `protoblocks/src/06-leave-one-provider-out/runs/20260614T011754Z-06-leave-one-provider-out-pilot/commands.jsonl`
- Providers: brave,exa,tavily,searchx
- Dataset: 3 fixed pilot cases; one Polymarket-style resolution-source, one current-news, one official-domain.
- Cost: $0.144
- Key metrics:

| Excluded | Lost sources | Avg lost | Lost expected-domain | Baseline provider cost saved USD | Failure rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| brave | 22 | 7.333 | 18 | 0 | 0 |
| exa | 27 | 9 | 11 | 0.021 | 0 |
| tavily | 23 | 7.667 | 6 | 0.015 | 0 |
| searchx | 32 | 10.667 | 5 | 0 | 0 |

- Interpretation: Pilot completed without measurement blockers; marginal source loss is visible in summary.json.
- Follow-up: rerun a 5-case pilot if failures appear; otherwise expand to the full mixed benchmark.
- Project change justified: none
