# Breadth test — wideband fan-out vs single providers

Measures how many distinct sources a fan-out sweep yields versus any single provider, for the same query at the same moment.

## Method

- 10 queries spanning technical, science, policy, consumer, news, and niche topics (see `run.ts`).
- One `scan` sweep per query: `max: 10` hits per provider, `fresh: true`, `timeoutMs: 15000`, all 11 configured providers.
- Per-provider breadth is derived from `Source.provenance` within the same sweep — provider *p*'s result set is the sources whose provenance includes *p*. Fair by construction: identical query, cap, and timing for every provider; no extra API calls.
- Unique contribution = `stats.providers[p].uniqueContributed` (sources only *p* found).

```bash
bun testing/breadth/run.ts   # rewrites results.json (~$0.32 in provider spend)
```

## Results (2026-07-06)

- **wideband union: 48.5 distinct sources/query avg** (range 28–64) — **4.8× the best single provider** (capped at 10).
- Cross-provider overlap averaged 50%: half of what any provider returns, no other provider has.
- exa (8.0) and sailor (8.2) contribute the most sources nobody else finds; brave and desearch contributed **zero** unique sources across all 10 queries.
- 109/110 provider calls succeeded (1 nimble timeout at 15s).
- Total cost: $0.32 for 10 sweeps.

## Files

- `run.ts` — the experiment; rerunnable.
- `results.json` — per-query raw: union size, per-provider found counts, statuses, latency, cost.
- `breadth.csv` — aggregated per-provider averages, graph-ready.
- `breadth.png` — the bar chart.

## Caveat

Unique-contribution is relative to the provider pool: removing a provider redistributes its "unique" credit to whoever else also found those sources. The union size and the multiplier are the robust claims.
