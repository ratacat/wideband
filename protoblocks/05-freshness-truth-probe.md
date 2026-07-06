# 05 - Freshness Truth Probe

## Goal

Measure whether providers return actually fresh results when wideband requests freshness.

The engine already records freshness support and post-filter stats. This experiment checks whether those stats reflect useful behavior on real queries.

## What This Teaches

- Which providers honor date filters.
- Which providers return undated pages that still may be useful.
- Which providers leak stale content into fresh searches.
- Which freshness policy works best for research workflows.

## Scope

This experiment may reveal bugs in freshness filtering. Fix measurement bugs if found, but do not add product features.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/05-freshness-truth-probe/
```

Store outputs under:

```text
protoblocks/src/05-freshness-truth-probe/runs/<timestamp>/
```

## Dataset

Use 40-80 queries across:

- Polymarket markets ending soon.
- Current news topics.
- Scheduled sports events.
- Recent economic releases.
- Weather events.

Each case should include:

```ts
type Case = {
  id: string
  q: string
  expectedFreshAfter: string
  category: string
}
```

For Polymarket cases, prefer:

```text
<market question> latest official update
```

## Run

Run each query with three freshness modes:

```sh
bun src/cli/main.ts research "<query>" --hours 24 --freshness strict --fresh --json
bun src/cli/main.ts research "<query>" --hours 24 --freshness balanced --fresh --json
bun src/cli/main.ts research "<query>" --hours 24 --freshness recall --fresh --json
```

Also run a no-freshness baseline:

```sh
bun src/cli/main.ts research "<query>" --fresh --json
```

Record:

```ts
type Row = {
  caseId: string
  provider: string
  policy: 'none' | 'strict' | 'balanced' | 'recall'
  totalSources: number
  keptUndated?: number
  keptStale?: number
  droppedStale?: number
  droppedUndated?: number
  staleVisibleCount: number
  undatedVisibleCount: number
  freshVisibleCount: number
  costUSD: number
  latencyMs: number
}
```

## Manual Audit

Sample 5 results per provider-policy pair. For each sampled source, mark:

- Fresh and relevant.
- Fresh but irrelevant.
- Stale but relevant.
- Stale and irrelevant.
- Undated and relevant.
- Undated and irrelevant.

Keep the audit file next to the run output.

## Metrics

- Fresh relevant rate.
- Stale leakage rate.
- Undated useful rate.
- Source loss from strict mode.
- Incremental useful sources from recall mode.
- Provider-native freshness versus post-filter performance.

## Success Criteria

The experiment succeeds when it recommends one freshness policy for:

- Time-sensitive research.
- Broad recall research.
- Polymarket resolution-source research.

It should also list providers whose freshness claims deserve distrust.

## What We Might Learn

- Strict freshness may discard useful official pages because many sources are undated.
- Recall mode may be better for Polymarket because official sources can be stable pages.
- Native freshness support may still produce stale pages.
- Post-filter providers may perform well if they return reliable `publishedAt` metadata.

## Results Log

### 2026-06-14 - Codex - 20260614T011515Z-05-freshness-truth-probe-pilot

- Commit/worktree: no `HEAD` revision available; working tree uncommitted/untracked.
- Commands: `bun src/cli/main.ts providers --json > protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot/providers.json`; `WIDEBAND_DB=protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot/ledger.db bun protoblocks/src/05-freshness-truth-probe/run-pilot.ts protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot`; `bun protoblocks/src/05-freshness-truth-probe/make-audit-sample.ts protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot`; `bun protoblocks/src/05-freshness-truth-probe/label-audit.ts protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot`; `bun protoblocks/src/05-freshness-truth-probe/finalize-summary.ts protoblocks/src/05-freshness-truth-probe/runs/20260614T011515Z-05-freshness-truth-probe-pilot`. Per-call `research` commands are in `commands.log`.
- Providers: `brave,exa,tavily,linkup,nimble` from Freshness-Capable; live inventory matched and all keys were present.
- Dataset: 3 hand-selected pilot cases, snapshotted before provider calls; categories were weather, sports schedule, and Polymarket-style Fed official-update research.
- Cost: `$0.264` across 60 provider calls; 0 provider error rows.
- Key metrics: source totals `none=147`, `strict=136`, `balanced=124`, `recall=127`; stale leakage `none=17.0%`, `strict=0%`, `balanced=0%`, `recall=0.8%`; undated visible rate `none=76.9%`, `strict=61.8%`, `balanced=58.9%`, `recall=58.3%`; manual audit useful rate `strict=72%`, `balanced=64%`, `none=64%`, `recall=60%`.
- Interpretation: `strict` reduced stale leakage but is not dated-only for native freshness providers; Tavily, Linkup, and Nimble surfaced mostly/all undated visible samples under strict. Brave and Exa were the only providers that consistently produced dated fresh samples in this pilot. The no-freshness baseline found the sampled official Fed calendar source that 24-hour freshness policies missed.
- Follow-up: run a larger case set with official-domain expectations, and separately test whether native undated retention under `strict` is intended measurement semantics.
- Project change justified: `needs_more_data`.
