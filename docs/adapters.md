# Target Adapters

Adapters return Effects and submit each logical request through the engine's request context. Responses are validated before normalization. Required URLs and result envelopes stay strict, while optional descriptive metadata may be null. Valid empty results differ from malformed responses.

Each retry has a separate persisted attempt and reservation. AnyAPI reserves $0.0009 per page for its default automatic fallback and records the provider's reported charge. Tavily reserves its published PAYG estimate of $0.008 for scan or $0.016 for research. Exa and Parallel include requested-result surcharges above ten. These are request estimates, not account invoices.

## Built

| Provider | Env key | Endpoint | Notes |
| --- | --- | --- | --- |
| anyapi | `ANYAPI_API_KEY` | `POST api.getanyapi.com/v1/run/google.search` | Google organic results, about 10 per page; one billed request per page; key falls back to `~/.anyapi/config.json` |
| Brave | `BRAVE_API_KEY` | `GET api.search.brave.com/res/v1/web/search` | web/news |
| Google | none | `GET www.google.com/search?gbv=1` through residential proxies | proxies from `WIDEBAND_PROXY_FILE`; uv, Python and `curl_cffi` |
| Exa | `EXA_API_KEY` | `POST api.exa.ai/search` | scan uses fast search; research asks for text |
| Parallel | `PARALLEL_API_KEY` | `POST api.parallel.ai/v1/search` | scan uses basic mode; research uses advanced mode |
| Perplexity | `PERPLEXITY_API_KEY` | `POST api.perplexity.ai/search` | web |
| Tavily | `TAVILY_API_KEY` | `POST api.tavily.com/search` | scan uses basic depth; research uses advanced depth and raw content |
| Jina | `JINA_API_KEY` | `POST s.jina.ai` | scan suppresses content; research keeps content |
| Linkup | `LINKUP_API_KEY` | `POST api.linkup.so/v1/search` | scan uses fast depth; research uses standard depth |
| Nimble | `NIMBLE_API_KEY` | `POST sdk.nimbleway.com/v2/search` | `lite` depth for scan, `deep` for research (full page text, about 15 s); `/v1/serp` hangs |
| Desearch | `DESEARCH_API_KEY` | `GET api.desearch.ai/web` | web |
| Sailor | `SAILOR_API_KEY` | `POST sailorsearch.dev/api/v1/search` | scan uses basic mode; research uses advanced mode |
| SearchX | `SEARCHX_API_KEY` | `GET searchx.dev/api/v1/search` | scan uses keyword mode; research uses hybrid mode; image search via `/images/search` |

## Candidate Backlog

These providers need current signup/API validation before adapters are built.

| Provider | Expected endpoint | Status |
| --- | --- | --- |
| SerpAPI | `GET serpapi.com/search?engine=google` | account email-confirmed; phone verification blocks API key |
| Search Router | `POST search-router.com/api/search` | blocked: signup is Google OAuth only; adapter not built |
