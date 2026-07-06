# Provider Sets

Snapshot date: 2026-06-14.

Generated from:

```sh
bun src/cli/main.ts providers --json
```

This snapshot records key presence and capability groups. It is not a live health check; `doctor` was not run.

## All Configured

Use this set when the experiment needs broad provider comparison and the call count is still within the run cap:

```text
brave,exa,parallel,perplexity,tavily,jina,linkup,nimble,desearch,sailor,searchx
```

All built providers currently have keys present.

## Low-Cost First Pass

Use this set for cheap pilots or smoke runs:

```text
brave,jina,desearch,sailor,searchx
```

Notes:

- `brave`: free quota, web/news, native freshness.
- `jina`: free quota, web, full content.
- `desearch`: metered but very cheap.
- `sailor`: free quota, web.
- `searchx`: free quota, web/image.

## Freshness-Capable

Use this set for freshness experiments:

```text
brave,exa,tavily,linkup,nimble
```

These adapters declare native freshness support.

## Domain-Filter Capable

Use this set for domain-filter experiments:

```text
exa,tavily,linkup,nimble
```

These adapters declare domain-filter support.

## Full-Content Capable

Use this set for content usefulness experiments:

```text
exa,parallel,tavily,jina
```

These adapters declare full-content support.

## News-Capable

Use this set for news-like Polymarket and currentness experiments:

```text
brave,exa,tavily,nimble
```

These adapters include `news` in `mediaTypes`.

## Notes for Subagents

- Prefer the provider set named by the assigned protoblock.
- If the file gives examples with a narrower set, use the narrower set for the pilot.
- If a provider fails in the pilot, keep the row and record the failure. Do not silently drop it.
- Record the exact provider set in `summary.json` and the `Results Log`.
