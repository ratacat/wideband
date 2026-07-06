# 10 - Dedup Measurement Sanity

## Goal

Verify that wideband's uniqueness metric is trustworthy.

Provider experiments depend on `uniqueSources`, `uniqueContributed`, and overlap. If canonicalization misses common URL variants, provider value metrics become misleading.

## What This Teaches

- Whether duplicate URLs inflate unique-source counts.
- Which providers return URL variants.
- Whether canonicalization handles common tracking and formatting differences.
- Whether live provider outputs need new dedup test fixtures.

## Scope

This experiment can justify core fixes, because dedup correctness affects all telemetry. Keep fixes narrow and test-backed.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/10-dedup-measurement-sanity/
```

Store outputs under:

```text
protoblocks/src/10-dedup-measurement-sanity/runs/<timestamp>/
```

## Part A - Synthetic Fixtures

Create fixture hits that should collapse into one source.

```ts
import { mergeHits } from '../../../src/core/merge'
import type { Hit } from '../../../src/core/types'

const hits: Hit[] = [
  { provider: 'a', rank: 1, url: 'http://www.example.com/story/?utm_source=x#top', title: 'Story', mediaType: 'web' },
  { provider: 'b', rank: 1, url: 'https://example.com/story', title: 'Story', mediaType: 'web' },
  { provider: 'c', rank: 1, url: 'https://example.com/story/?ref=home', title: 'Story', mediaType: 'web' },
]

const sources = mergeHits(hits)
if (sources.length !== 1) throw new Error(`expected 1 source, got ${sources.length}`)
```

Add cases for:

- `http` versus `https`.
- `www` versus bare host.
- Tracking params.
- Fragments.
- Trailing slash.
- Sorted query params.
- Provider duplicate within one result set.

## Part B - Live Provider Variants

Run broad queries likely to produce duplicate syndicated URLs:

```sh
bun src/cli/main.ts research "Federal Reserve FOMC statement official June 2026" --max 10 --fresh --full --json
bun src/cli/main.ts research "latest bitcoin ETF SEC filing official" --max 10 --fresh --full --json
bun src/cli/main.ts research "NBA finals box score official" --max 10 --fresh --full --json
```

Capture raw provider outputs with:

```sh
bun src/cli/main.ts research "<query>" --max 10 --fresh --capture --full --json
```

Record suspected duplicates:

```ts
type DuplicateCandidate = {
  query: string
  sourceA: string
  sourceB: string
  reason: 'amp' | 'mobile' | 'tracking' | 'syndication' | 'http_https' | 'slash' | 'other'
  currentlyMerged: boolean
}
```

## Metrics

- Synthetic fixture pass/fail count.
- Live suspected duplicate count.
- Duplicate candidates currently merged.
- Duplicate candidates currently missed.
- Estimated unique-source inflation.
- Providers most associated with URL variants.

## Success Criteria

The experiment succeeds when it produces:

- A fixture list with expected canonical outputs.
- A live duplicate candidate list.
- A clear answer: current dedup is adequate, or specific canonicalization fixes are needed.
- Test cases for any accepted fix.

## What We Might Learn

- Current canonicalization may already handle the common cases.
- AMP and mobile URL variants may need special handling.
- Some duplicates may be semantic syndication, not URL canonicalization, and should remain separate.
- Provider uniqueness metrics may be overcounting if canonicalization misses common variants.

## Results Log

### 2026-06-14 - Codex - 20260614T012659Z-10-dedup-measurement-sanity-pilot

- Commit/worktree: no HEAD in this repo; uncommitted worktree.
- Commands: `bun protoblocks/src/10-dedup-measurement-sanity/run-pilot.ts`; live calls used `WIDEBAND_DB=protoblocks/src/10-dedup-measurement-sanity/runs/20260614T012659Z-10-dedup-measurement-sanity-pilot/ledger.db bun src/cli/main.ts research "<query>" --providers brave,jina,desearch,sailor,searchx --max 10 --timeout 30000 --fresh --capture --full --json`.
- Providers: Low-Cost First Pass: `brave,jina,desearch,sailor,searchx`.
- Dataset: 8 synthetic fixtures plus 3 fixed live queries, snapshotted to `cases.jsonl` before live calls.
- Cost: `$0.00075`.
- Key metrics: synthetic fixtures `8/8` passed; provider calls `15/15` completed with `0` failures; live hits `149`, unique sources `121`, overlap `18.8%`; suspected duplicate candidates `2`, currently merged `2`, currently missed `0`; estimated unique-source inflation `0`.
- Interpretation: current canonicalization handled the required fixture variants and the pilot live variants (`http_https`, `slash`); no dedup measurement bug appeared.
- Follow-up: run a larger AMP/mobile-targeted live sample before changing canonicalization for those cases.
- Project change justified: `none`.
