# Protoblock Pilot Report - 2026-06-14

## Scope

Ten protoblock pilots ran in parallel subagents. These were pilot runs, not full evaluations. The goal was to validate experiment design, expose obvious provider behavior, and identify which full runs are worth paying for.

No core wideband behavior changed. Generated protoblock runner scripts are marked `// @ts-nocheck` because they are disposable experiment code.

## Run Totals

- Experiments completed: 10/10.
- Approximate provider rows/calls: 361.
- Approximate reported/metered cost: $0.72175.
- Root typecheck after cleanup: pass.
- Test suite after cleanup: 40 pass, 0 fail.

## Runs

| # | Experiment | Run ID | Providers | Cases | Provider rows | Cost |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 01 | Polymarket resolution-source recall | `20260614T011807Z-01-polymarket-resolution-source-recall-pilot` | brave,jina,desearch,sailor,searchx | 5 | 25 | $0.00125 |
| 02 | Polymarket category matrix | `20260614T011442Z-02-polymarket-category-matrix-pilot` | brave,jina,desearch,sailor,searchx | 5 | 25 | $0.00125 |
| 03 | Polymarket liquidity matrix | `20260614T011801Z-03-polymarket-liquidity-matrix-pilot` | brave,jina,desearch,sailor,searchx | 6 | 30 | $0.00150 |
| 04 | Polymarket query phrasing sensitivity | `20260614T011748Z-04-polymarket-query-phrasing-sensitivity-pilot` | brave,jina,desearch,sailor,searchx | 3 | 75 | $0.00375 |
| 05 | Freshness truth probe | `20260614T011515Z-05-freshness-truth-probe-pilot` | brave,exa,tavily,linkup,nimble | 3 | 60 | $0.26400 |
| 06 | Leave-one-provider-out | `20260614T011754Z-06-leave-one-provider-out-pilot` | brave,exa,tavily,searchx | 3 | 48 | $0.14400 |
| 07 | Cost per useful source | `20260614T012338Z-07-cost-per-useful-source-pilot` | brave,jina,desearch,sailor,searchx,exa,tavily | 5 | 35 | $0.06125 |
| 08 | Full-content usefulness | `20260614T012424Z-08-full-content-usefulness-pilot` | exa,parallel,tavily,jina | 4 | 16 | $0.06800 |
| 09 | Domain-filter reliability | `20260614T012505Z-09-domain-filter-reliability-pilot` | exa,tavily,linkup,nimble | 4 | 32 | $0.17600 |
| 10 | Dedup measurement sanity | `20260614T012659Z-10-dedup-measurement-sanity-pilot` | brave,jina,desearch,sailor,searchx | 11 total | 15 | $0.00075 |

## Strongest Signals

### Domain filters are worth a full run

Experiment 09 had the cleanest result:

- Constrained compliance: 160/160 on-domain sources.
- Unconstrained compliance: 67/158 on-domain sources.
- Expected-path hit rate improved from 37.3% to 75.6%.
- Exa, Tavily, Linkup, and Nimble all had 0 off-domain leakage in the pilot.

This justifies a larger domain-filter evaluation. It does not yet justify a product change, but it strongly suggests that official-source workflows should use domain-capable providers when expected domains are known.

### Query phrasing matters

Experiment 04 showed the domain-in-query template beat all other templates:

- `domain`: 9/15 expected-host hits.
- `official`: 5/15.
- `raw`: 4/15.
- `evidence`: 4/15.
- `resolution`: 3/15.

Best provider hits in that pilot:

- Brave: 8/15.
- Desearch: 7/15.
- Jina: 5/15, but 7 timeout rows.
- Sailor: 5/15.
- SearchX: 0/15.

This argues for testing query templates before testing more providers.

### Active Polymarket markets are weak ground truth for `resolutionSource`

Experiments 01, 02, and 04 all hit the same problem: active/open Gamma samples often lacked usable URL-valued `resolutionSource` fields.

The pilots had to use closed-market fallback for resolution-source recall. Full Polymarket experiments should explicitly sample recently closed markets, or they should use expected domains from market-specific rules instead of relying on `resolutionSource`.

### Long-tail markets are the hard case

Experiment 03:

- Hot bucket useful rate: 14/80 = 17.5%.
- Middle bucket useful rate: 6/88 = 6.8%.
- Long-tail bucket useful rate: 0/75 = 0%.

The long-tail failures were mostly wrong/generic results, not empty result sets. That means "more results" is not enough; the next run needs stricter target/source definitions.

### Freshness policy needs clearer semantics

Experiment 05:

- No freshness: 17.0% stale leakage.
- Strict: 0% stale leakage.
- Balanced: 0% stale leakage.
- Recall: 0.8% stale leakage.
- Manual useful rate: strict 72%, balanced 64%, none 64%, recall 60%.

Caveat: strict is not dated-only for native freshness providers. Tavily, Linkup, and Nimble still surfaced many/all undated visible samples under strict. The engine semantics are consistent with current code, but the label "strict" may mislead users if they expect dated-only output.

### Full-content providers returned useful content

Experiment 08:

- Content presence: 96.2%.
- Expected-term hit rate: 78.5%.
- Useful-content rate: 76.6%.
- Cost per useful full-content source: $0.000562.
- Tavily had the highest useful-content rate at 85%.
- Jina had the lowest useful-content rate at 65.8%, but cost was $0.

The pilot supports running a larger full-content evaluation. It also found broken examples on Reuters/Instagram-like pages, so full-content metrics need manual spot checks.

### Dedup looks healthy for common variants

Experiment 10:

- Synthetic fixtures: 8/8 passed.
- Live hits: 149.
- Live unique sources: 121.
- Duplicate candidates: 2.
- Both candidates were already merged.
- Estimated unique-source inflation: 0.

No dedup fix is justified from this pilot.

## Provider Notes

### Brave

Brave was consistently useful and cheap:

- Resolution-source top-10 recall: 40% in experiment 01.
- Category winners included sports and macro in experiment 02.
- In experiment 05, strict/balanced/recall freshness produced 100% fresh-visible sources for the sampled rows.
- In experiment 06, removing Brave lost the most expected-domain sources: 18 across 3 cases.

Brave deserves inclusion in broader pilots.

### Desearch

Desearch was a strong low-cost performer:

- Resolution-source top-10 recall: 40%.
- Politics category winner in experiment 02.
- Useful long-tail/category contribution despite low metered cost.
- Slower than Brave and Sailor in these pilots.

Desearch is worth more testing as a cheap recall provider.

### Sailor

Sailor was uneven but had useful wins:

- Resolution-source top-10 recall: 40%.
- Best average first match rank in experiment 01 among providers with hits.
- Category winners included crypto and culture.
- Weak useful-source rate in experiment 07.

Sailor needs category-specific evaluation before any default conclusion.

### SearchX

SearchX had mixed signals:

- No expected-host hits in query phrasing pilot.
- 0 useful sources in the liquidity pilot.
- Removing SearchX lost the most raw sources in leave-one-out: 32 across 3 cases.
- Cost/useful heuristic ranked it well, but manual audit showed the heuristic over-accepted generic results.

SearchX may be good for breadth, but its value needs stricter labels.

### Jina

Jina was unstable in search-style pilots:

- 3/5 timeouts in experiment 01.
- 4/5 timeouts in experiment 02.
- 5/6 timeouts in experiment 03.
- 7 timeout rows in experiment 04.

But Jina worked in full-content and dedup pilots when timeout settings differed:

- Full-content useful rate: 65.8%.
- Dedup live calls: 0 failures with 30s timeout.

Jina should not be judged as "bad"; it needs timeout/mode-specific testing.

### Exa, Tavily, Linkup, Nimble

The paid/domain-capable providers performed well where their capabilities mattered:

- Domain filters: all had 100% constrained compliance in experiment 09.
- Freshness: Exa and Brave produced dated fresh output under strict; Tavily/Linkup/Nimble often returned undated output while still avoiding stale leakage.
- Full content: Exa and Tavily were useful; Tavily led content usefulness in the pilot.

The next full run should compare paid providers against cheap providers only on tasks where capability matters.

## Measurement Caveats

### Usefulness labels are too loose

Experiment 07 manually audited 35 labels:

- 24 agreements.
- 11 disagreements.
- Accepted-source precision sample: 59.3%.

The heuristic over-accepted generic entity matches and broad expected-domain pages. Cost-per-useful conclusions should be treated as provisional until labels are stricter.

### Resolution-source recall needs better cases

Active Polymarket markets often lacked usable `resolutionSource`. Full runs should:

- Sample recently closed markets.
- Keep only URL-valued resolution sources.
- Add expected-domain cases where exact URL is unavailable.

### Several pilots compare different provider sets

This was intentional. Capability pilots used capability-specific providers, and low-cost pilots used cheap providers. Cross-provider rankings should stay within each experiment, not across all ten.

### Generated scripts are experiment artifacts

The runner scripts live under `protoblocks/src/**`. They are useful for reruns, but they are not production code. They are marked `// @ts-nocheck` to keep project typecheck focused on wideband.

## Recommended Next Runs

Run these in order.

1. Full domain-filter reliability run.
   - 25-40 cases.
   - Providers: Exa, Tavily, Linkup, Nimble.
   - Keep constrained and unconstrained modes.
   - This is the cleanest pilot and directly teaches official-source behavior.

2. Query phrasing run on better Polymarket cases.
   - 20 recently closed markets with URL-valued `resolutionSource`.
   - Providers: Brave, Desearch, Sailor, Exa, Tavily.
   - Templates: raw, official, domain, and one hand-written source-specific form.

3. Freshness semantics run.
   - 10-20 cases with manually known fresh/stale ground truth.
   - Providers: Brave, Exa, Tavily, Linkup, Nimble.
   - Goal: decide whether docs/UI should distinguish "dated strict" from "provider-native strict".

4. Full-content run.
   - 20 cases, balanced by page type.
   - Providers: Exa, Tavily, Parallel, Jina.
   - Manual audit required.

5. Long-tail Polymarket run.
   - 20-30 long-tail markets.
   - Use the best query template from experiment 04.
   - Include paid providers, because low-cost providers found 0 useful long-tail sources in the pilot.

## Decisions Not Justified Yet

- Do not drop any provider.
- Do not add query routing.
- Do not change default provider sets.
- Do not change dedup logic.
- Do not rely on the current usefulness heuristic for cost-based provider decisions.

## Decisions That Are Reasonable To Prepare

- Treat domain-constrained SDK sweeps as a high-value research path.
- Treat query phrasing as an experiment variable, not an implementation detail.
- Document freshness caveats before exposing strong user claims.
- Keep protoblocks isolated from production typecheck expectations.
