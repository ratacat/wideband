# Keyword research — how people search for agentic search tooling

Explore-mode conjecture cascade, 2026-07-06. 14 probes across 6 lenses; 4 grounded with live npm + web searches. Directions are validated against what actually surfaces; no search-volume claims.

## Keyword list (28, clustered, strongest first)

### A. Agent-native head terms (highest intent; this is the live vocabulary)

Exa's own tagline is literally "Search API for AI Agents".

1. ai search api
2. search api for ai agents
3. agentic search
4. agentic web search
5. agent web search
6. web search for llm
7. llm search api
8. ai web search api

### B. Aggregation / fan-out — wideband's niche (low volume, near-zero competition)

9. multi provider search
10. search api aggregator
11. metasearch api
12. federated web search
13. search fan out
14. deduplicated search results
15. unique sources search
16. search provider comparison

### C. RAG / grounding plumbing (LLM-app dev phrasing)

17. rag web search
18. llm grounding api
19. web grounding llm
20. real time web data
21. search and scrape api

### D. Ecosystem hooks (where tool-shaped discovery happens)

22. mcp web search
23. web search mcp server
24. deep research api
25. ai research agent search

### E. Semantic / embedding direction (real but provider-branded — people search "exa neural search", rarely generic)

26. neural search api
27. semantic web search api
28. embedding search api

### Buyer-intent long-tails (target in README/blog copy, not as keywords)

- best search api for ai agents
- exa vs tavily vs brave
- search api cost comparison
- cost per search api

## Findings from live probes

- **"Agentic search" is a benchmark category.** AIMultiple runs an "Agentic Search" eval of 8 APIs (Brave 14.89, Exa ~14.4, Tavily ~13.5). Comparison content dominates the SERP; roundups converge on "most serious builders end up using at least two of the three" — wideband's pitch verbatim, and nobody owns the query.
- **The aggregator slot is nearly empty.** Multi-provider/dedup queries surface only SearXNG (self-hosted metasearch, no dedup guarantee, not agent-oriented) and one tiny npm package (`@zhafron/mcp-web-search`, 3 providers). No incumbent owns "multi-provider search with real dedup + cost telemetry."
- **npm search matches on the `keywords` field.** wideband's package.json had none until this research; fixed alongside this doc.
- **"Cost per unique source" appears nowhere in the wild** — a category-defining phrase to coin, not compete for.
- **MCP phrasing dominates npm discovery** — "mcp web search" and "deep research mcp" both return pages of active packages; an MCP wrapper would be a discoverability channel, not just a feature.
- Barren directions: old-SEO vocab ("serp api", rank tracking — wrong buyer, SERP-fidelity market); bare "ai search" (collides with consumer Perplexity-style market).

## Where keywords were placed

- `package.json` `keywords` array (clusters A/B/C/D + provider names).
- README intro: "multi-provider **web search API for AI agents**".
- README tail: FAQ section (buyer-intent long-tails as questions) and Glossary section (agentic search, metasearch, RRF, LLM grounding, cost per unique source).

## Parked for a future round

- `reciprocal rank fusion` long-tail (practitioner-only).
- Non-English/regional vocabulary probe.
- Search-volume validation per keyword (Google Trends / keyword tools) — this round validated direction, not volume.
