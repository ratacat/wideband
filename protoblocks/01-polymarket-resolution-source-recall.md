# 01 - Polymarket Resolution-Source Recall

## Goal

Measure which providers can find the official resolution source for Polymarket markets.

This experiment uses Polymarket as a source of ground truth. Many markets expose a `resolutionSource` URL in the public Gamma API. A provider earns credit when it returns that exact URL, the same canonical URL, or the same official domain near the top of results.

## What This Teaches

- Which providers find primary sources instead of commentary.
- Which providers need query help to reach official sources.
- Whether provider uniqueness matters for resolution-source discovery.
- Whether some providers mostly return Polymarket pages, social posts, or SEO summaries.

## Scope

This is a learning experiment only. Do not add routing, scoring, or provider-selection behavior to wideband from this file. Capture results, then decide later.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

1. Install dependencies.

   ```sh
   bun install
   ```

2. Confirm provider keys.

   ```sh
   bun src/cli/main.ts providers --json
   ```

3. Create experiment code under:

   ```text
   protoblocks/src/01-polymarket-resolution-source-recall/
   ```

4. Write run output under:

   ```text
   protoblocks/src/01-polymarket-resolution-source-recall/runs/<timestamp>/
   ```

## Dataset

Fetch active markets from Polymarket's public Gamma API and keep markets with a non-empty `resolutionSource`.

Use this endpoint as the base:

```text
https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100
```

Minimum viable run:

- 25 markets with `resolutionSource`.
- At least 3 categories if category fields are available.
- At least 4 configured providers.

Better run:

- 100 markets.
- Include active and recently closed markets.
- Stratify by category and volume.

## Suggested Script

Create `protoblocks/src/01-polymarket-resolution-source-recall/run.ts`.

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wideband } from '../../../src/index'

type GammaEvent = {
  slug?: string
  title?: string
  markets?: {
    slug?: string
    question?: string
    resolutionSource?: string | null
    volumeNum?: number
    category?: string
  }[]
}

function canonicalHost(raw: string) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return raw
  }
}

function sourceMatches(sourceUrl: string, expectedUrl: string) {
  try {
    const source = new URL(sourceUrl)
    const expected = new URL(expectedUrl)
    source.hash = ''
    expected.hash = ''
    return (
      source.toString() === expected.toString() ||
      source.hostname.replace(/^www\./, '') === expected.hostname.replace(/^www\./, '')
    )
  } catch {
    return false
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join('protoblocks/src/01-polymarket-resolution-source-recall/runs', stamp)
mkdirSync(outDir, { recursive: true })

const events = (await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100').then((r) =>
  r.json(),
)) as GammaEvent[]

const cases = events
  .flatMap((event) =>
    (event.markets ?? []).map((market) => ({
      id: market.slug ?? event.slug ?? market.question ?? crypto.randomUUID(),
      q: `${market.question} official resolution source`,
      question: market.question,
      resolutionSource: market.resolutionSource,
      expectedHost: market.resolutionSource ? canonicalHost(market.resolutionSource) : undefined,
    })),
  )
  .filter((item) => item.resolutionSource)
  .slice(0, 50)

const wb = wideband()
const providers = ['brave', 'exa', 'tavily', 'linkup', 'nimble', 'searchx']
const rows = []

for (const c of cases) {
  for (const provider of providers) {
    const result = await wb.research(c.q, { providers: [provider], max: 10, fresh: true, timeoutMs: 12000 })
    const matches = result.sources
      .map((source, index) => ({ rank: index + 1, url: source.url, match: sourceMatches(source.url, c.resolutionSource!) }))
      .filter((x) => x.match)

    rows.push({
      caseId: c.id,
      provider,
      query: c.q,
      resolutionSource: c.resolutionSource,
      expectedHost: c.expectedHost,
      hitTop3: matches.some((m) => m.rank <= 3),
      hitTop10: matches.length > 0,
      firstMatchRank: matches[0]?.rank ?? null,
      totalSources: result.sources.length,
      costUSD: result.cost.totalUSD,
      latencyMs: result.timing.totalMs,
      providerStats: result.stats.providers[provider],
    })
  }
}

writeFileSync(join(outDir, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
wb.close()
```

## Run

```sh
bun protoblocks/src/01-polymarket-resolution-source-recall/run.ts
```

Then summarize:

```sh
jq -s '
  group_by(.provider) |
  map({
    provider: .[0].provider,
    cases: length,
    top3: map(select(.hitTop3)) | length,
    top10: map(select(.hitTop10)) | length,
    avg_cost: (map(.costUSD) | add / length),
    avg_latency_ms: (map(.latencyMs) | add / length)
  })
' protoblocks/src/01-polymarket-resolution-source-recall/runs/*/rows.jsonl
```

## Metrics

- `top3_recall`: share of cases with expected URL/domain in ranks 1-3.
- `top10_recall`: share of cases with expected URL/domain in ranks 1-10.
- `first_match_rank`: average rank of first expected-source match.
- `cost_per_top10_hit`: provider cost divided by cases with a top-10 hit.
- `polymarket_leakage`: share of returned URLs on `polymarket.com`.

## Success Criteria

The experiment succeeds when it produces a provider table with at least:

- Number of cases.
- Top-3 recall.
- Top-10 recall.
- Average latency.
- Cost per successful case.
- Three concrete examples where providers disagree.

## What We Might Learn

- Exa or Tavily may dominate official-source recall because they support domain/freshness features.
- Brave may provide cheap broad recall but miss narrow official URLs.
- Some providers may return high-ranking Polymarket event pages instead of resolution sources.
- Query phrasing may matter more than provider choice.

## Results Log

### 2026-06-14 - Codex - 20260614T011807Z-01-polymarket-resolution-source-recall-pilot

- Commit/worktree: no git commit available; worktree appears untracked.
- Commands: `RUN_ID=20260614T011807Z-01-polymarket-resolution-source-recall-pilot WIDEBAND_DB=protoblocks/src/01-polymarket-resolution-source-recall/runs/20260614T011807Z-01-polymarket-resolution-source-recall-pilot/ledger.db bun protoblocks/src/01-polymarket-resolution-source-recall/run.ts`; verification: `bunx tsc --noEmit` failed only in other protoblock scripts.
- Providers: Low-Cost First Pass: `brave,jina,desearch,sailor,searchx`.
- Dataset: 5-case pilot. Active/open Gamma events had 0 markets with non-empty `resolutionSource` among 100 events, so the run used the closed-market fallback before provider calls; closed fallback had 90 candidates, selected by category round-robin.
- Cost: `$0.00125` reported/estimated total.
- Key metrics: overall row-level top-10 recall `6/25 = 0.24`; failures `3/25` (all Jina timeouts). Provider top-10 recall: Brave `0.40`, Jina `0.00`, DeSearch `0.40`, Sailor `0.40`, SearchX `0.00`. Provider top-3 recall: Brave `0.00`, Jina `0.00`, DeSearch `0.20`, Sailor `0.20`, SearchX `0.00`.
- Interpretation: the low-cost set found official domains inconsistently and often ranked Polymarket or broad context pages above the resolution source. Active/open Gamma markets currently do not supply usable `resolutionSource` values for this experiment.
- Follow-up: run a second pilot with domain/freshness/full-content providers (`exa,tavily,linkup,nimble` or the all-configured set) and compare query phrasing against this closed-market fallback sample.
- Project change justified: `none`.
