# Target Adapters

## Built

| Provider | Env key | Endpoint | Notes |
| --- | --- | --- | --- |
| anyapi | `ANYAPI_API_KEY` | `POST api.getanyapi.com/v1/run/google.search` | Google organic results, about 10 per page; one billed request per page; key falls back to `~/.anyapi/config.json` |
| Brave | `BRAVE_API_KEY` | `GET api.search.brave.com/res/v1/web/search` | web/news |
| Google | none | `GET www.google.com/wml/search` through residential proxies | proxies from `WIDEBAND_PROXY_FILE`; uv, Python and `curl_cffi` |
| Exa | `EXA_API_KEY` | `POST api.exa.ai/search` | scan uses fast search; research asks for text |
| Parallel | `PARALLEL_API_KEY` | `POST api.parallel.ai/v1/search` | scan uses basic mode; research uses advanced mode |
| Perplexity | `PERPLEXITY_API_KEY` | `POST api.perplexity.ai/search` | web |
| Tavily | `TAVILY_API_KEY` | `POST api.tavily.com/search` | scan uses basic depth; research uses advanced depth and raw content |
| Jina | `JINA_API_KEY` | `POST s.jina.ai` | scan suppresses content; research keeps content |
| Linkup | `LINKUP_API_KEY` | `POST api.linkup.so/v1/search` | scan uses fast depth; research uses standard depth |
| Nimble | `NIMBLE_API_KEY` | `POST sdk.nimbleway.com/v1/serp` | uses Fast SERP; AI Search `/v1/search` hangs on the trial workspace |
| Desearch | `DESEARCH_API_KEY` | `GET api.desearch.ai/web` | web |
| Sailor | `SAILOR_API_KEY` | `POST sailorsearch.dev/api/v1/search` | scan uses basic mode; research uses advanced mode |
| SearchX | `SEARCHX_API_KEY` | `GET searchx.dev/api/v1/search` | scan uses keyword mode; research uses hybrid mode; image search via `/images/search` |

## Candidate Backlog

These providers need current signup/API validation before adapters are built.

| Provider | Expected endpoint | Status |
| --- | --- | --- |
| SerpAPI | `GET serpapi.com/search?engine=google` | account email-confirmed; phone verification blocks API key |
| Search Router | `POST search-router.com/api/search` | blocked: signup is Google OAuth only; adapter not built |
