# 02 - Polymarket Category Matrix

## Goal

Measure provider behavior across Polymarket market categories.

The same provider may perform well on politics and poorly on sports, or well on crypto and poorly on entertainment. This experiment separates provider quality by topic class instead of averaging everything into one score.

## What This Teaches

- Which providers specialize by topic.
- Which categories produce high overlap versus unique sources.
- Whether Polymarket research needs different provider mixes for different categories.
- Whether category-specific query phrasing changes the useful-source rate.

## Scope

Do not add category-aware routing to wideband during this experiment. Produce a matrix and examples only.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/02-polymarket-category-matrix/
```

Store outputs under:

```text
protoblocks/src/02-polymarket-category-matrix/runs/<timestamp>/
```

Confirm available providers first:

```sh
bun src/cli/main.ts providers --json
```

## Dataset

Build a balanced sample of Polymarket markets across categories.

Preferred categories:

- Politics.
- Crypto.
- Sports.
- Macro/economics.
- Weather/climate.
- Culture/entertainment.

Fetch candidate events:

```text
https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=0
https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=100
https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=200
```

If Gamma category fields are incomplete, classify with a small local rule table. Keep the rules in the run output.

Minimum viable run:

- 5 categories.
- 10 markets per category.
- 4 providers.

Better run:

- 6 categories.
- 25 markets per category.
- All configured providers.

## Suggested Classification

Use explicit keyword rules before adding any model-based classifier.

```ts
function classify(question: string) {
  const q = question.toLowerCase()
  if (/\b(election|trump|biden|senate|congress|president|minister|party)\b/.test(q)) return 'politics'
  if (/\b(bitcoin|btc|ethereum|eth|solana|crypto|token)\b/.test(q)) return 'crypto'
  if (/\b(nfl|nba|mlb|nhl|ufc|soccer|match|game|championship)\b/.test(q)) return 'sports'
  if (/\b(cpi|fed|rates|inflation|gdp|unemployment|jobs)\b/.test(q)) return 'macro'
  if (/\b(weather|temperature|hurricane|rain|snow|climate)\b/.test(q)) return 'weather'
  if (/\b(movie|album|box office|oscar|grammy|celebrity)\b/.test(q)) return 'culture'
  return 'other'
}
```

## Run

For each market, run one query per provider:

```text
<market question> latest official source
```

Use `research` for this experiment because content and richer retrieval matter.

```sh
bun src/cli/main.ts research "<market question> latest official source" \
  --providers brave,exa,tavily,linkup,nimble,searchx \
  --max 10 \
  --fresh \
  --json
```

The script should write one JSONL row per `(case, provider)`:

```ts
type Row = {
  caseId: string
  category: string
  provider: string
  query: string
  sources: number
  uniqueContributed: number
  officialDomainHits: number
  polymarketHits: number
  costUSD: number
  latencyMs: number
  topDomains: string[]
}
```

## Metrics

- Sources per provider per category.
- Unique contribution rate per category.
- Official-domain hit rate, if `resolutionSource` exists.
- Polymarket-page rate.
- Cost per useful source.
- Latency per category.

## Success Criteria

The experiment succeeds when it produces:

- A category x provider table.
- The best and worst provider for each category.
- At least one example query per category where provider behavior diverged.
- A note on whether category labels were reliable.

## What We Might Learn

- Sports may favor providers with fast news indexing.
- Crypto may favor providers that index exchange, protocol, and price pages well.
- Politics may show high overlap because the source universe is large and well-indexed.
- Weather may reveal weak official-source recall unless queries name the station or agency.
- Culture markets may produce low-authority sources and high SEO noise.

## Results Log

### 2026-06-14 - Codex - 20260614T011442Z-02-polymarket-category-matrix-pilot

- Commit/worktree: uncommitted; `git rev-parse --short HEAD` failed with `fatal: Needed a single revision`.
- Commands: `bun src/cli/main.ts providers --json > protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot/providers.json`; `curl -fsSL 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=0' -o protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot/gamma-events-offset-0.json`; `curl -fsSL 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=100' -o protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot/gamma-events-offset-100.json`; `curl -fsSL 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=200' -o protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot/gamma-events-offset-200.json`; `bun protoblocks/src/02-polymarket-category-matrix/prepare-cases.ts protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot`; `bun protoblocks/src/02-polymarket-category-matrix/run-pilot.ts protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot`; exact provider calls are in `protoblocks/src/02-polymarket-category-matrix/runs/20260614T011442Z-02-polymarket-category-matrix-pilot/commands.txt`.
- Providers: Low-Cost First Pass: `brave,jina,desearch,sailor,searchx`.
- Dataset: 5 open Polymarket markets from Gamma offsets 0/100/200; first reliable match across politics, crypto, sports, macro, culture. Weather/climate had no reliable question match in the sampled pages.
- Cost: `$0.00125` reported/estimated total; only `desearch` was metered in this set.
- Key metrics: 25 calls, 25 rows, 210 sources, 45 heuristic useful sources, 11 Polymarket hits, 4 failures. Failures were all `jina` timeouts. Category winners by useful sources: politics `desearch`, crypto `sailor`, sports `brave`, macro `brave`, culture `sailor`. Category worst provider: `jina` for all five categories.
- Interpretation: provider behavior diverged materially by category even in the pilot. `brave` was fastest and strongest on sports/macro, `sailor` was strongest on crypto/culture, and `desearch` was strongest on politics but slower. `jina` needs either higher timeout or separate treatment before drawing category conclusions.
- Follow-up: run a larger balanced sample with an explicit requirement for cases that have `resolutionSource` when available; separately test whether increasing `jina` timeout changes the result.
- Project change justified: `needs_more_data`.
