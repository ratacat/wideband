# 09 - Domain-Filter Reliability

## Goal

Measure whether providers obey domain constraints and whether constrained searches improve official-source discovery.

Domain filtering is central to high-trust research. If a provider claims domain-filter support, wideband needs to know whether the output actually stays on target.

## What This Teaches

- Which providers comply with include-domain constraints.
- Whether domain filtering improves or harms recall.
- Which providers fake, ignore, or weaken domain filters.
- Which official domains are hard to search.

## Scope

This experiment may expose adapter bugs. Fix adapter request-shaping bugs if the provider supports filters and wideband sends them incorrectly. Do not add new provider features from this run.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/09-domain-filter-reliability/
```

Store outputs under:

```text
protoblocks/src/09-domain-filter-reliability/runs/<timestamp>/
```

## Dataset

Use 60 cases with known target domains:

- Government agencies.
- Courts or regulators.
- Sports leagues.
- Weather offices.
- Crypto protocol docs.
- Company investor-relations pages.
- Polymarket `resolutionSource` hosts.

Case shape:

```ts
type Case = {
  id: string
  q: string
  includeDomains: string[]
  expectedPathTerms?: string[]
  category: string
}
```

## Providers

Start with providers whose adapters declare `domainFilters: true`:

- Exa.
- Tavily.
- Linkup.
- Nimble.

Run one non-domain provider as a control if useful.

## Run

The current CLI does not expose `domains.include`. Use the SDK for this protoblock.

```ts
import { wideband } from '../../../src/index'

const wb = wideband()
const result = await wb.research(
  {
    q: 'Federal Reserve FOMC statement June 2026',
    domains: { include: ['federalreserve.gov'] },
    max: 10,
  },
  { providers: ['exa'], fresh: true },
)
wb.close()
```

If the SDK helper does not accept object input, use `Engine.sweep` directly with `UnifiedQuery.parse`.

Record:

```ts
type Row = {
  caseId: string
  provider: string
  constrained: boolean
  includeDomains: string[]
  totalSources: number
  onDomainSources: number
  offDomainSources: number
  expectedPathHits: number
  costUSD: number
  latencyMs: number
  offDomainUrls: string[]
}
```

## Metrics

- Domain compliance rate.
- Expected-path hit rate.
- Recall loss versus unconstrained search.
- Precision gain versus unconstrained search.
- Off-domain leakage examples.
- Cost per on-domain useful source.

## Success Criteria

The experiment succeeds when it produces:

- Compliance table per provider.
- Before/after comparison for constrained versus unconstrained search.
- At least ten off-domain leakage examples, or a clear note that none appeared.
- A list of domains that remain difficult even with filtering.

## What We Might Learn

- Some providers may obey domain filters strictly but lose useful recall.
- Some providers may treat filters as hints.
- Domain filters may be most useful for official-source probes and less useful for broad context.
- The CLI may need domain flags later, but only after SDK experiments prove the value.

## Results Log

### 2026-06-14 - Codex - 20260614T012505Z-09-domain-filter-reliability-pilot

- Commit/worktree: uncommitted/no git commit available; workspace had untracked files before this run.
- Commands: `bun --check protoblocks/src/09-domain-filter-reliability/run-pilot.ts` (this Bun version executed the script); internal snapshot command `WIDEBAND_DB=protoblocks/src/09-domain-filter-reliability/runs/20260614T012505Z-09-domain-filter-reliability-pilot/ledger.db bun src/cli/main.ts providers --json`; SDK sweeps recorded in `protoblocks/src/09-domain-filter-reliability/runs/20260614T012505Z-09-domain-filter-reliability-pilot/commands.log`.
- Providers: exa, tavily, linkup, nimble (Domain-Filter Capable).
- Dataset: 4 fixed pilot cases with one include domain each; sampled from embedded seed list; case cap 4.
- Cost: $0.176000 reported/estimated.
- Key metrics: 32/32 successful rows; constrained compliance 1 vs unconstrained 0.424051; constrained expected-path hit rate 0.75625; constrained off-domain leakage examples captured 0.
- Interpretation: pilot data is enough to exercise the measurement path; use the full sample before changing defaults.
- Follow-up: run the 60-case full sample after reviewing leakage/difficult-domain rows.
- Project change justified: needs_more_data
