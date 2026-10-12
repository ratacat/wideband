<p align="center">
  <img src="https://raw.githubusercontent.com/ratacat/wideband/main/assets/wideband-hero.jpg" alt="Bar chart: unique sources found across 11 providers — wideband 48.5 vs best single provider 8.2" width="100%">
</p>

# wideband

[![npm](https://img.shields.io/npm/v/wideband)](https://www.npmjs.com/package/wideband)

A multi-provider web search API for AI agents. One query runs across configured providers and returns ranked, deduplicated sources with provenance and recorded or estimated costs. Google uses your proxy inventory.

Search providers overlap heavily. For agentic research the number that matters is **unique sources per dollar** — wideband exists to maximize it and to measure it.

- **15 provider adapters** — anyapi (Google results), Brave, Desearch, Exa, Google, Google browser, Jina, Linkup, Maps (Google Maps places), Nimble, Parallel, Perplexity, Sailor, SearchX, Tavily. Google and Maps are included in default scans. Google browser runs only when you select it.
- **Real deduplication** — URL canonicalization (tracking params, fragments, default ports stripped) plus metadata union, so five providers returning the same article yield one Source with five provenance entries.
- **Reciprocal Rank Fusion** ranking — robust across heterogeneous providers, no score-normalization games.
- **Request accounting.** Each potentially billable attempt reserves budget before dispatch and gets a durable SQLite record. Reported charges, estimates, and unresolved charges remain distinct.
- **Streaming results.** `--stream` emits provider snapshots as they finish and then the final result. Compatible concurrent SDK searches share work.
- **Usage ledger.** SQLite retains attempts, provider outcomes, latency, and costs. `wideband stats` reports provider contributions; `wideband costs` includes unresolved attempts.
- **Robot-mode CLI** — JSON by default, meaningful exit codes, `--pretty` when a human is watching.

Built on [Bun](https://bun.sh), Effect 4 for execution and schemas, and Cheerio for Google HTML. Google also requires uv, Python, and residential proxies.

## Quick start

Requires [Bun](https://bun.sh) (the CLI and library run on it).

```bash
npm install -g wideband   # or: bun add -g wideband

export EXA_API_KEY=...    # any provider keys you have — see the Providers table below
wideband providers --pretty
wideband scan "bun sqlite WAL" --max 5 --pretty
```

Using it as a library: `npm install wideband`, then `import { wideband } from 'wideband'` (see [SDK](#sdk)).

From source instead:

```bash
git clone https://github.com/ratacat/wideband && cd wideband
bun install && bun link       # puts the `wideband` bin on your PATH
cp .env.example .env          # add keys for the providers you use
```

API providers participate when their key is present. Google is included by default and uses `WIDEBAND_PROXY_FILE`.

```
$ wideband providers --pretty
brave: key free quota 1203/2000
exa: key metered
tavily: key metered
jina: key free quota 203/1000
...
```

## Two modes

| Mode | Optimized for | Provider behavior |
| --- | --- | --- |
| `scan` | Fast, cheap source discovery | Fast/basic depth, content suppressed |
| `research` | Rich retrieval for deep reading | Advanced depth, full page text where supported |

## CLI

```bash
wideband scan "latest topic" --hours 5 --providers brave,exa,linkup --fresh
wideband research "article research topic" --providers exa,tavily,jina --max 10
wideband providers    # adapters + key/quota status
wideband stats        # uniqueness, cost per unique source, latency by provider
wideband costs        # month-to-date spend
wideband doctor       # live-validate keys
wideband schema       # JSON Schema for outputs
```

Key flags:

- `--providers a,b,c` — restrict the fan-out
- `--max N` — per-provider hit limit, 1–100; providers can return fewer
- `--google-pages N` — Google, Google browser, AnyAPI, or Maps page limit, 1–10; defaults `--max` to ten times this value unless explicitly set; an explicit provider list must include one of them
- `--budget USD` — cap on request reservations, including retries and pages; see the cost model below
- `--timeout MS` — provider deadline including queue waits, requests, and retries
- `--stream` — provider snapshots and the final result as NDJSON
- `--hours N` / `--after DATE` / `--before DATE` — freshness window
- `--freshness strict|balanced|recall` — what to do with undated or stale results (default `balanced`)
- `--session NAME` — suppress sources already seen in this session across sweeps
- `--fresh` / `--ttl SECONDS` — bypass or tune the result cache (cache hits cost $0)
- `--fields url,title,score` / `--full` — projection control
- `--json` / `--pretty` — output for robots (default) or humans

Exit codes: `0` ok · `1` no results · `2` bad args · `3` config · `4` budget · `5` all providers failed.

## MCP server

`wideband-mcp` ships in the package: a stdio MCP server exposing `scan`, `research`, and `providers` as tools, so any MCP client (Claude Code, Claude Desktop, Cursor, ...) gets multi-provider web search as a single tool call.

```json
{
  "mcpServers": {
    "wideband": {
      "command": "wideband-mcp",
      "env": { "EXA_API_KEY": "...", "TAVILY_API_KEY": "..." }
    }
  }
}
```

Provider keys come from the server process environment or the shell that launches the client. Tool arguments include `q`, `max`, `googlePages`, `providers`, `budget`, and `hours`. MCP request cancellation reaches provider work. EOF waits for accepted requests; SIGTERM cancels them and waits for cleanup.

## SDK

```ts
import { wideband } from 'wideband'

const wb = wideband()

try {
  const result = await wb.scan('bun sqlite WAL', { budget: 0.05 })
  for (const source of result.sources) {
    console.log(source.score, source.url, source.providers)
  }
  console.log(result.cost.totalUSD, result.cost.unknownAttempts)

  for await (const event of wb.stream('Effect TypeScript')) {
    if (event.kind === 'provider') console.log(event.provider, event.sources)
    else console.log(event.result)
  }
} finally {
  await wb.close()
}
```

Pass `signal: AbortSignal` in search options to cancel a caller. Cancelling one caller leaves shared work running for other callers. Breaking out of a stream releases its subscription.

`providers()`, `stats()`, `costs()`, and `close()` return Promises. `close()` is idempotent and rejects subsequent work. Sources in provider events are cumulative snapshots, so replace earlier sources with the same IDs. The final event contains the batch result.

Every sweep returns a `SweepResult`:

```ts
type Source = {
  id: string
  url: string
  title: string
  snippet: string
  content?: string
  publishedAt?: string
  providers: string[]
  provenance: { provider: string; rank: number; score?: number }[]
  uniqueTo?: string
  score: number
}

type SweepResult = {
  sweepId: string
  complete: boolean
  sources: Source[]
  stats: {
    totalHits: number
    uniqueSources: number
    overlapPct: number
    providers: Record<string, { status: string; hits: number; uniqueContributed: number; latencyMs: number; attempts: number }>
  }
  cost: {
    totalUSD: number
    unknownAttempts: number
    byProvider: Record<string, {
      usd: number
      basis: 'reported' | 'metered' | 'amortized' | 'free' | 'unknown' | 'mixed'
      observedUSD: number
      estimatedUSD: number
      unknownAttempts: number
      attempts: number
    }>
  }
  timing: { totalMs: number }
}
```

## How a sweep works

1. Select configured providers whose capabilities match the query.
2. Run provider effects concurrently. Each request reserves budget and records a pending attempt before network work. Retries repeat that request, preserving successful earlier pages.
3. Validate responses before normalization. Merge hits by canonical URL and retain each provider's provenance, the longest content, and the earliest publication date.
4. Rank sources by Reciprocal Rank Fusion, `score = Σ 1/(60 + rank_p)`.
5. Return the sources and accounting. A provider that loses a later page can contribute a `partial` result with `complete: false`. Complete successful sweeps, including valid empty results, can be cached. Session suppression happens per caller after retrieval.

SDK calls reject with `WidebandError` when every provider fails. Its `result` retains provider outcomes and costs. The CLI prints that result and exits with code 5. Storage failures surface as `LedgerError`.

## Cost model

Three billing realities, modeled explicitly per provider:

```ts
type CostModel =
  | { kind: 'metered';      perRequestUSD: number }                          // top-up credits (Exa, Tavily, Parallel)
  | { kind: 'subscription'; monthlyUSD: number; includedRequests: number }   // flat fee, amortized per request
  | { kind: 'free';         monthlyQuota?: number }                          // $0, quota tracked (Brave free)
```

`wideband costs` shows month-to-date spend and quota consumption per provider.

### What providers cost

As configured in the adapters (modeled estimate; provider-reported dollars override it per call when available):

| Provider | Modeled cost | Free allowance |
| --- | --- | --- |
| Brave | free tier | ~2,000 req/mo ($5/mo in credits; paid: ~$5/1k) |
| SearchX | free tier | 90,000 req/mo |
| Jina | free tier | 1,000 req/mo |
| Sailor | free tier | 500 req/mo |
| Desearch | $0.00025/req | signup credits |
| Exa | $0.007/req plus $0.001 per requested result above 10 | account allowance applies |
| Tavily | $0.008 scan, $0.016 research | PAYG estimate; account credits and plans can cost less |
| Linkup | $0.005/req | 4,000 signup queries + $5/mo credit top-up |
| Parallel | $0.005/req plus $0.001 per requested result above 10 | signup credits |
| Perplexity | $0.005/req | signup credits |
| Nimble | $0.005/req | trial workspace |
| anyapi | $0.0005/page base; reserve up to $0.0009 for automatic fallback | provider reports the charge |
| Google | $0/req; you pay for the proxies; with `WIDEBAND_2CAPTCHA_KEY`, a captcha solve adds about $0.003, up to 300 a day | your proxy plan |
| Google browser | $0/req; you pay for the proxies; with `WIDEBAND_2CAPTCHA_KEY`, a captcha solve adds about $0.003, up to 300 a day | your proxy plan |
| Maps | $0/req; you pay for the proxies, about 36 KB per page | your proxy plan |

Prices are modeled estimates, not account invoices. Free-tier models assume the allowance applies. `--budget` limits reservations before each attempt. A reported amount replaces its reservation. A lost response retains the reserved estimate and increments `unknownAttempts`; it does not silently become free. Actual provider charges can differ from a stale model, and cancellation cannot undo a dispatched request.

Exa, Parallel, Tavily, and AnyAPI estimates were checked on October 2, 2026 against [Exa pricing](https://exa.ai/docs/admin/pricing.md), [Parallel pricing](https://docs.parallel.ai/getting-started/pricing), [Tavily credits](https://docs.tavily.com/documentation/api-credits.md), and [the AnyAPI catalog](https://api.getanyapi.com/catalog). Other rows retain the existing adapter models. Google proxy costs are outside these totals.

## Telemetry

SQLite stores sweeps, provider outcomes, request attempts, cached results, and seen source IDs at `~/.wideband/ledger.db`. `WIDEBAND_DB` selects another file. Attempt records survive cancellation and failed final summaries. `wideband costs` reports monthly `attempts` and unresolved charges. `wideband stats` reports settled provider operations as `calls`, with uniqueness and cost per unique source. Historical rows from before 0.4 have only provider-operation counts, so their monthly attempt counts remain approximate.

## Providers

Google is included in default scans alongside configured API providers. Google browser is not. An explicit `--providers` list replaces the default set:

```sh
wideband scan "scuba diving shops bonaire"
wideband scan "scuba diving shops bonaire" --providers google,brave --google-pages 3
wideband scan "site:padi.com/dive-center/" --providers google --google-pages 10
```

Wideband has two Google providers, and you choose one. `google` is the fast HTTP route with warm slots. `google-browser` is a slow, opt-in route through headless Chrome, for when `google` keeps failing. Nothing falls back from one to the other.

### Local Maps provider

The `maps` adapter asks Google Maps for places through the same proxy inventory, without a subprocess. Each place becomes one source. The title is the place name, the URL is its website or a Google Maps link to the place, and the snippet joins the address, category, and phone. A page holds up to 20 places, and `--google-pages` reads further pages. A query that names no place returns no Maps results, so Maps adds little to default scans of other topics.

```sh
wideband scan "live music venue Salt Lake City Utah" --providers maps --max 20
```

### Local Google provider

The `google` adapter runs the search transport on your machine and fetches Google's result pages through your proxy inventory. It requires no Google API key or remote search service. Google sees the proxy's exit IP.

#### Set up the connection

Install Bun 1.4 or newer, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Python 3.10 or newer. Warm the pinned Python dependency before your first timed search:

```sh
uv run --with curl-cffi==0.16.3 python -c 'import curl_cffi; print("Google transport ready")'
```

Save your proxy provider's connection details in a private file outside the repository, such as `~/.config/wideband/proxies.txt`. Create its parent directory if necessary. Use one line for a rotating residential gateway. With Webshare, use the username that ends in `-rotate`; wideband turns it into one sticky session per slot. The `host:port:username:password` format is sufficient:

```text
p.webshare.io:80:USERNAME-rotate:PASSWORD
```

A list of static proxies, one per line, also works. Slot N uses line N modulo the number of lines, and a blocked slot is replaced by a fresh one, so a static list wears out faster than a rotating gateway.

Replace those example values with your own. Export the file's absolute path, restrict its permissions, and test Google alone:

```sh
export WIDEBAND_PROXY_FILE="$HOME/.config/wideband/proxies.txt"
chmod 600 "$WIDEBAND_PROXY_FILE"
wideband scan "Effect TypeScript" --providers google --max 3 --fresh --full
```

The same variable works for the SDK and standalone Google module. For an MCP client, set `WIDEBAND_PROXY_FILE` in the environment of the server it launches. Desktop clients may not inherit your shell's exports. The CLI and MCP server also read the package's `.env` file; `.env.example` includes the variable. Use an absolute path there.

The file also accepts `username:password@host:port`, `host:port` for IP-allowlisted proxies, and complete proxy URLs. For example:

```text
http://USERNAME:PASSWORD@proxy.example.net:8080
```

A JSON inventory supports separate credential fields and an optional `protocol`, which defaults to `http`:

```json
[
  {
    "host": "proxy.example.net",
    "port": 8080,
    "username": "USERNAME",
    "password": "PASSWORD",
    "protocol": "http"
  }
]
```

Credentials in these separate fields are URL-encoded by wideband. Complete URLs must already encode reserved characters correctly. Blank lines and lines beginning with `#` are ignored in text inventories. Keep the inventory private; it contains proxy credentials.

#### How and why it works

The transport in [google-search.mjs](src/google-search.mjs) starts `uv`, which runs Python with pinned `curl_cffi==0.16.3`. It passes one request through stdin: the method, URL, query parameters or form, headers, the slot's cookies, and the proxy. It receives the response and the cookies it set as JSON.

The request targets Google's `/search` endpoint with `gbv=1` and an old feature-phone User-Agent. That combination returns compact HTML containing the search results without requiring a JavaScript browser. A results page is about 5.5 KB gzip-compressed. The request fixes `hl=en`, `gl=us`, and `pws=0`. As of October 2026, Google answers `/wml/search` with HTTP 403.

Each new slot picks a random User-Agent from [google-agents.json](src/google-agents.json) and keeps it for the slot's life. The file groups agents into families, and each family has its own ordered header set; `"User-Agent": null` marks where the agent goes in that order. The transport sends exactly those headers over HTTP/1.1. Google serves the light page to few User-Agents, and it blocks one after heavy use: NokiaN72 and then Nokia6230i went from mostly ok to blocked on every try within hours. In an October 10, 2026 test of 147 old-browser User-Agents, 23 Samsung `GT-` phones with NetFront 3.5 to 4.2 got results. Most others got Google's "browser isn't supported" page or HTTP 403. Test a new agent through the gateway before you add it.

`curl_cffi` supplies the `chrome99_android` TLS profile, with its default Chrome headers turned off. Google's block followed the User-Agent string, not the TLS profile: in the same test, five TLS profiles gave the same outcome. [curl_cffi's browser impersonation documentation](https://github.com/lexiforest/curl_cffi#features).

Cheerio extracts organic result cards, titles, snippets, and next-page offsets. The parser unwraps Google redirect links; the adapter canonicalizes URLs and removes duplicates. This depends on Google's current page format. CAPTCHA, consent, JavaScript challenges, and unrecognized markup produce errors rather than successful empty results. This is an HTML integration, not a documented Google search API.

#### Direct IP versus proxies

An ordinary home or office IP may work for occasional direct requests. Repeated automated searches can trigger restrictions affecting that public IP, including other users sharing the connection. Google documents these shared-network effects in its [unusual traffic guidance](https://support.google.com/websearch/answer/86640).

For regular or batch use, use a rotating residential gateway. This implementation has been verified with Webshare in October 2026. A blocked slot is deleted and the next try uses a fresh slot with a new exit IP, so a block costs one retry. Proxy reputation and traffic from other customers still matter; buying proxies does not guarantee uninterrupted access.

**The current adapter requires `WIDEBAND_PROXY_FILE` and has no direct-IP mode.** An unset or empty inventory fails before contacting Google. A local forward proxy that uses your machine's public IP still exposes that same exit IP.

#### Warm slots

Webshare usernames control rotation. `USERNAME-rotate` gives each connection a new exit IP, and `USERNAME-<N>` keeps one exit IP for session N. Wideband rewrites `-rotate` to a slot number from 50,000 to 99,999, so each slot keeps one exit IP. A line without `-rotate` is used as written. A slot also keeps one User-Agent and the cookies Google set on its IP.

The `slots` table in `~/.wideband/google-tries.sqlite` holds the warm slots. A warm slot passed a query and has not been blocked since. A try leases the ready slot that has waited longest, for 30 seconds, so two processes never use one slot at once. A slot waits 12 seconds between queries. If no slot is ready, the try makes a fresh one. A block deletes the slot, and so do 30 idle minutes. In an October 12, 2026 probe at that pace, three of four fixed IPs served 30 of 30 searches with no block, and a kept-alive page took 0.6 seconds.

Wideband does not choose the exit country. Use your provider's endpoint controls when you need country-specific exits. List the warm slots with `sqlite3 -readonly ~/.wideband/google-tries.sqlite "SELECT slot, family, queries, datetime(used_at / 1000, 'unixepoch') FROM slots"`.

#### Retries and try history

A page makes at most five tries. Each try leases a warm slot or makes a fresh one.

- A block, a transport failure, or another non-200 response deletes the slot, is recorded, and is retried at once. A block is a redirect to Google's `/sorry` page, HTTP 429, a CAPTCHA page, a consent page, a JavaScript challenge, or the `unsupported` page Google shows a User-Agent it no longer serves.
- Unrecognized markup stops the search so a parser change cannot be hidden by repeated tries. The slot stays warm.
- Each try has a 20-second network timeout, and each page has a 75-second deadline, or 195 seconds when `WIDEBAND_2CAPTCHA_KEY` is set.
- Google has a 240-second provider deadline. `--timeout` changes that provider deadline; the page and network limits still apply.

The `tries` table in `~/.wideband/google-tries.sqlite` keeps one row per try for seven days: the time `at` in milliseconds, the `query`, the `attempt` number, the `outcome` (`ok`, `blocked`, `transport`, and so on), the exit `ip`, the `bytes`, the `proxy` as `host:port`, the User-Agent `family` and `agent`, and the `slot`. It holds no credentials. Google encodes the exit IP in its `/sorry` redirect, so `ip` is filled for blocked tries only. `bytes` counts the HTTP request and the compressed response as curl reports them. TLS and the proxy's CONNECT exchange come on top: in October 2026 an ok try read about 7.4 KB in `bytes` and measured 12 to 14 KB on the wire. Writing the history is best-effort and never fails a search. Count the last hour's tries and bytes with `sqlite3 -readonly ~/.wideband/google-tries.sqlite "SELECT outcome, attempt, count(*), sum(bytes) FROM tries WHERE at > (strftime('%s','now') - 3600) * 1000 GROUP BY 1, 2"`. Find worn-out agents with `sqlite3 -readonly ~/.wideband/google-tries.sqlite "SELECT agent, count(*), round(100.0 * sum(outcome != 'ok') / count(*)) FROM tries WHERE at > (strftime('%s','now') - 3600) * 1000 GROUP BY 1 ORDER BY 3 DESC"`.

Cancellation kills the transport process group on macOS and Linux and waits for it to close. If a later page fails, earlier hits remain available with provider status `partial` and `complete: false`.

#### Clear blocked pages with 2captcha

In an hour when Google blocks most fresh exit IPs, a page can fail after five blocked tries. When `WIDEBAND_2CAPTCHA_KEY` holds a [2captcha](https://2captcha.com) API key, wideband pays about $0.003 to clear one blocked slot, and that slot stays warm for later searches. The key is the switch, and callers pass no flag or option. Without the key, nothing changes.

Put the key in your environment or in the package's `.env`. SDK callers set it in `process.env`.

```sh
export WIDEBAND_2CAPTCHA_KEY=...
wideband scan "live music Ogden UT" --providers google
```

- A page makes at most one solve, and only when its second or later try is blocked. A block on the first try is usually followed by a fresh slot that passes.
- Wideband makes at most 300 solve attempts in 24 hours, about $0.90. It counts the `tries` rows from the last 24 hours whose outcome is `solved` or starts with `solve:`, on both routes, failed attempts included. At 300, a blocked page goes on as if no key were set. If the count cannot be read, no solve runs.
- A solve took 19 to 33 seconds in tests. With the key set, the page deadline grows from 75 to 195 seconds.
- 2captcha reports the charge, and the ledger records it as an observed cost, so `wideband costs` and `wideband stats` include it. A page that paid nothing records $0 as a free estimate.
- `--budget` treats Google as free. It reserves nothing for a solve and cannot stop one. The daily limit bounds the spend.
- `google-browser` follows the same key and limit, and submits the token in the page. The browser pool keeps the environment it started with, so a changed key reaches it after the pool restarts.
- The `tries` table records each solve with outcome `solved` or `solve:<code>`, such as `solve:timeout`. Count the last 24 hours with `sqlite3 -readonly ~/.wideband/google-tries.sqlite "SELECT count(*) FROM tries WHERE (outcome = 'solved' OR outcome LIKE 'solve:%') AND at > (strftime('%s','now') - 86400) * 1000"`.

In an October 12, 2026 test, a page whose first two tries were blocked solved in 19 seconds for $0.00299 and returned results after 24 seconds. Its slot then served 10 of 10 searches.

#### Pagination and troubleshooting

Google fetches one page by default, even with `--max 100`. Use `--google-pages` to follow next-page offsets:

```sh
wideband scan "site:padi.com/dive-center/" --providers google --google-pages 3 --max 30 --fresh
```

A search stops at the page limit, result limit, or end of results. Ten pages can produce fewer than 100 unique URLs. Proxy locations can change rankings, so this is source discovery rather than a stable rank-tracking measurement.

The provider supports English US web results. Search and research return the same snippets; Google images, news, video endpoints, and full-page content are outside this adapter. Put `site:` operators in the query instead of structured domain filters. Undated snippets retain their uncertainty under wideband's freshness policy.

For a failed first search:

- For an `inventory` error, check the file path, contents, and permissions first.
- A `runtime` error means the subprocess could not start or complete. Run the uv dependency command above in the same environment.
- An `exhausted` error lists each failed try in order, such as `blocked, blocked, transport`. Check proxy authentication, IP allowlisting, exit reputation, and the provider's network access.
- The ledger records each failed Google page as `google:<reason>` in `attempts.error_code`, such as `google:inventory` or `google:blocked,transport,blocked`. Count recent reasons with `sqlite3 -readonly ~/.wideband/ledger.db "SELECT error_code, count(*) FROM attempts WHERE provider='google' AND status='error' GROUP BY 1 ORDER BY 2 DESC"`.
- A timeout means the tries did not finish within the page deadline, usually because the gateway is slow. Raising the overall timeout does not remove the page deadline.
- An `unrecognized` error means the HTML parser could not identify results or an explicit no-results page. Check the parser against the returned page format.

Google's recorded search-API fee is zero. Proxy bandwidth and inventory costs are outside wideband's budget and cost totals. 2captcha charges are inside those totals.

SDK calls use `scan({ q: 'dive shops', googlePages: 3, max: 30 }, { providers: ['google'] })`. MCP `scan` and `research` accept `googlePages` and derive the default `max` from it. The standalone parser and page client are exported from `wideband/google-search` and run on Node 22.16 or newer.

Run `bun run build` and `bun testing/google-live.ts` for live CLI checks using your configured proxies and providers.

### Google browser provider

The `google-browser` provider asks a local pool of warm headless Chrome sessions for each page. It is opt-in: default scans skip it, and it runs only when `--providers` names it. Use it when `google` keeps failing. It is slow, and Google often answers a new Chrome session with a captcha. In an October 12, 2026 test of 100 queries, it returned 46 pages with a median of 25 seconds each, and 37 of 39 sessions got a captcha on their first query. The `google` provider returned 89 pages for the same queries.

The pool needs installed Google Chrome and the optional `patchright` package. The first `google-browser` search starts it in the background with `wideband browser`. It listens on `127.0.0.1:47651`, logs to `~/.wideband/browser.log`, and exits after 30 idle minutes. It uses the same `WIDEBAND_PROXY_FILE`, with sticky sessions from 10,000 to 49,999.

```sh
wideband scan "live music Ogden UT" --providers google-browser
```

When `WIDEBAND_2CAPTCHA_KEY` is set, a request that gets a captcha pays 2captcha once to clear it, within the same daily limit, and the session stays warm. A new session's first query usually gets the captcha. In an October 12, 2026 test, such a request returned results after 43 seconds.

### Google through AnyAPI

The `anyapi` provider returns Google results through the [anyapi](https://getanyapi.com) `google.search` API, with no local proxies, uv, or Python. Its published base price is $0.0005 per page, and default automatic fallback can cost up to $0.0009. Each attempt reserves that upper bound and then records the reported amount. It reads its key from `ANYAPI_API_KEY`, or else from `~/.anyapi/config.json`. `--google-pages` sets its page count.

Page depth participates in cache keys. Other providers retain their own result caps and are not paginated by `--google-pages`.

| Provider | Env key |
| --- | --- |
| Brave | `BRAVE_API_KEY` |
| Desearch | `DESEARCH_API_KEY` |
| Exa | `EXA_API_KEY` |
| anyapi | `ANYAPI_API_KEY`, or `~/.anyapi/config.json` |
| Google | `WIDEBAND_PROXY_FILE` |
| Google browser | `WIDEBAND_PROXY_FILE`, Google Chrome, and `patchright` |
| Google captcha solving, up to 300 a day | `WIDEBAND_2CAPTCHA_KEY` |
| Jina | `JINA_API_KEY` |
| Linkup | `LINKUP_API_KEY` |
| Nimble | `NIMBLE_API_KEY` |
| Parallel | `PARALLEL_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| Sailor | `SAILOR_API_KEY` |
| SearchX | `SEARCHX_API_KEY` |
| Tavily | `TAVILY_API_KEY` |

Endpoints and per-provider quirks: [docs/adapters.md](docs/adapters.md).

## Docs

- [docs/architecture.md](docs/architecture.md) — design shape, adapter seam, data schemas, merge/ranking policy
- [docs/adapters.md](docs/adapters.md) — built adapters and candidate backlog
- [protoblocks/](protoblocks/) — measurement experiments: provider recall, freshness truth, cost per useful source

## Development

```bash
bun run test
bun run typecheck
bun run build
```

`bun run test` exercises the SDK and CLI against a local HTTP server, then drives the MCP process over stdio. It makes no paid provider calls. After building, `bun testing/effect-e2e.ts --dist` checks the generated SDK and CLI with the same scenarios. The separate Google live harness uses configured providers and proxies.

## Upgrade to 0.4

Await `providers()`, `stats()`, `costs()`, and `close()`. Monthly provider usage exposes `attempts`. Schema exports are Effect Schema values; use `parseQuery` and `parseSweepResult` or Effect's decoder functions in place of Zod `.parse`. Engine and Ledger are internal and no longer exported from the package. Provider adapters return Effects and submit individual request receipts through their context. Incomplete results expose `complete: false`, and all-provider failure rejects SDK calls while preserving the CLI's exit 5 result output.

## FAQ

**Which is the best web search API for AI agents — Exa, Tavily, Brave, Linkup, Perplexity?**
Wrong question. They overlap heavily but each finds sources the others miss; every serious comparison ends with "use at least two." Wideband makes "all of them" one API call and tells you afterward which ones earned their cost.

**How do I deduplicate search results across multiple providers?**
URL canonicalization (strip tracking params, fragments, default ports) plus metadata union — that's wideband's merge step. Five providers returning the same article yield one Source with five provenance entries.

**What does an AI search API actually cost per query?**
Cost depends on provider, result count, depth, page count, retries, and account pricing. `wideband costs` reports observed, estimated, and unresolved usage. `wideband stats` compares cost per unique source across settled provider operations.

**Does this work as an MCP web search or LangChain tool?**
It's a plain TypeScript SDK and a JSON-emitting CLI, so wrapping it as an MCP server or agent-framework tool is a thin adapter. The CLI's robot mode (JSON out, meaningful exit codes) was designed for exactly that.

## Glossary

- **Agentic search** — web search shaped for LLM agents: structured results, content extraction, freshness controls, tool-call ergonomics.
- **Multi-provider search / metasearch** — fanning one query across several search engines and merging the results; wideband is this, rebuilt for the agent era with real deduplication.
- **Reciprocal Rank Fusion (RRF)** — rank-merging algorithm that combines heterogeneous result lists without comparing raw scores across providers.
- **LLM grounding** — feeding a model current web sources so its answers cite reality; RAG web search is the retrieval half of that loop.
- **Cost per unique source** — dollars spent divided by sources no other provider found; the metric wideband exists to maximize and measure.

## License

MIT
