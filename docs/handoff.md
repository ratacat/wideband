# wideband - Handoff

Read [architecture.md](architecture.md) first. It is the source of truth.

## Current State

Verified on 2026-06-12:

- Runtime: Bun + TypeScript. Runtime dependency: `zod`; storage: `bun:sqlite`.
- CLI: `wideband` is linked and exposes `scan`, `research`, `providers`, `stats`, `costs`, `doctor`, and `schema`.
- Tests: `bun run typecheck` passes; `bun test` passes with 34 tests.
- Built adapters: Brave, Exa, Parallel, Perplexity, Tavily, Jina, Linkup, Nimble, Desearch, Sailor, SearchX.
- Local keys present: `BRAVE_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, `LINKUP_API_KEY`, `NIMBLE_API_KEY`, `DESEARCH_API_KEY`, `SAILOR_API_KEY`, `SEARCHX_API_KEY`.
- Live status: all keyed providers validate except Desearch, which reports no balance. Tavily uses a fresh `wideband-20260612` dev key. Nimble uses Fast SERP because AI Search `/v1/search` hangs on the trial workspace.

## Modes

- `wideband scan <query>`: fast source discovery.
- `wideband research <query>`: heavier provider retrieval for article research.
- Use `--hours`, `--after`, or `--before` for content freshness; use `--fresh` only to bypass the TTL cache.
- SDK mirrors the CLI with `wb.scan()` and `wb.research()`. `wb.sweep()` remains the lower-level entry point.

## Engine Notes

- Fan-out runs concurrently with `Promise.all`.
- Each provider has one timeout deadline; retry backoff must fit inside it.
- Cache keys include the normalized query, included providers, and `capture`.
- `doctor` checks providers concurrently.

## Candidate Providers

No adapters exist yet for these candidates:

| Provider | Expected endpoint | Signup/API status |
| --- | --- | --- |
| SerpAPI | `GET serpapi.com/search?engine=google` | account email-confirmed; phone verification blocks API key |
| Search Router | `POST search-router.com/api/search` | blocked: signup is Google OAuth only; no agent-email path found |

Use `agent@clearfeed.tech` for signups. Read inbound codes with `cloudmail code --wait 90`. Do not print full keys; store them in `.env` only.
