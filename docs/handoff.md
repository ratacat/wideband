# Wideband implementation handoff

The 0.4 redesign uses Effect 4.0.0 for provider I/O, schemas, request policy, and scoped execution. Read [architecture.md](architecture.md) for current behavior and [effect-4-plan.md](effect-4-plan.md) for the original investigation.

## Public changes

- `wideband()` remains a synchronous factory. Search methods return Promises, and `stream()` returns an asynchronous iterator.
- Await `providers()`, `stats()`, `costs()`, and `close()`. Closing is idempotent and cancels active work before releasing SQLite.
- Monthly usage exposes `attempts`. Settled provider statistics retain `calls`.
- Schema exports are Effect Schema values. `parseQuery` and `parseSweepResult` replace direct Zod parsing.
- Engine and Ledger are internal. `AdapterError`, `LedgerError`, and `WidebandError` are exported.
- `complete: false` and provider status `partial` expose retained results after incomplete work. Total provider failure rejects SDK calls with the collected result attached. CLI output preserves that result with exit 5.
- `--stream` emits provider snapshots followed by the final result as NDJSON.

## Behavior to preserve

Each dispatched attempt has a durable record and its own budget reservation. Successful earlier pages survive retries and later failures. Unknown charges retain their reservation and remain visible. A storage failure before dispatch prevents spending.

Only complete successful searches enter the persistent cache. Compatible concurrent calls share execution and accounting. Session claims happen per caller at final delivery. Breaking a stream or cancelling one caller releases that subscription without stopping work needed by others.

Google retains process-group termination, close waiting, Node compatibility, and cross-process proxy pacing. No new runtime configuration settings were introduced.

## Checks

Run these from the repository root:

```bash
bun run typecheck
bun run test
bun run build
```

The test command uses local HTTP, SQLite, actual CLI processes, and actual MCP stdio. `testing/google-live.ts` uses real providers and proxies. Preserve the distinction when reporting results.

Live checks during the migration succeeded for Brave, Exa, Desearch, AnyAPI, Tavily, Parallel, and Google. Other configured providers returned quota, rate-limit, server, or timeout errors. Parallel's documented nullable metadata was corrected after the initial live check. Provider credentials and quotas may change independently of the code.

## Later product work

Adaptive provider selection remains outside this migration. It requires measurements of marginal unique sources by query type. Effect does not make synchronous SQLite queries nonblocking or guarantee provider charges match estimates.
