# 08 - Full-Content Usefulness

## Goal

Measure whether providers that claim full-content support return usable page text.

Full content matters only if it contains the article body, official text, or evidence needed by a research agent. Long boilerplate, navigation text, and truncated summaries should not count as useful content.

## What This Teaches

- Which full-content providers return clean body text.
- Which providers return snippets labeled as content.
- Whether full content improves answer-bearing source discovery.
- Whether content quality differs by site type.

## Scope

This experiment evaluates provider output. Do not add content-cleaning logic unless the run exposes a narrow bug in current normalization.

## Before Running

Follow `RUN_PROTOCOL.md`. Write `cases.jsonl` before provider calls, write `rows.jsonl` using `result-row.schema.json`, and use `USEFUL_SOURCE_RUBRIC.md` for usefulness labels.

## Setup

Use:

```text
protoblocks/src/08-full-content-usefulness/
```

Store outputs under:

```text
protoblocks/src/08-full-content-usefulness/runs/<timestamp>/
```

## Dataset

Use 50 URLs or queries across:

- News articles.
- Official agency pages.
- Company investor-relations pages.
- Blog posts.
- Polymarket resolution-source pages.
- Pages with tables or structured content.

Prefer cases where the answer-bearing phrase is known. Example:

```ts
type Case = {
  id: string
  q: string
  expectedTerms: string[]
  expectedDomain?: string
  pageType: 'news' | 'agency' | 'company' | 'blog' | 'resolution_source' | 'structured'
}
```

## Providers

Focus on providers with `fullContent: true`:

- Exa.
- Tavily.
- Jina.
- Parallel.

Include one non-full-content provider as a control.

## Run

Use `research` mode:

```sh
bun src/cli/main.ts research "<query>" \
  --providers exa,tavily,jina,parallel,brave \
  --max 10 \
  --full \
  --fresh \
  --json
```

Record one row per source:

```ts
type Row = {
  caseId: string
  provider: string
  url: string
  title: string
  contentLength: number
  snippetLength: number
  expectedTermHits: number
  boilerplateScore: number
  hasContent: boolean
  contentUseful: boolean
  costUSD: number
  latencyMs: number
}
```

## Simple Content Scoring

Use deterministic checks first.

```ts
function expectedTermHits(content: string, terms: string[]) {
  const lower = content.toLowerCase()
  return terms.filter((term) => lower.includes(term.toLowerCase())).length
}

function boilerplateScore(content: string) {
  const lower = content.toLowerCase()
  const boilerplate = ['subscribe', 'cookie', 'privacy policy', 'sign up', 'advertisement', 'all rights reserved']
  return boilerplate.filter((term) => lower.includes(term)).length
}
```

Manual audit should override the heuristic for sampled rows.

## Metrics

- Content presence rate.
- Median content length.
- Expected-term hit rate.
- Boilerplate score.
- Useful-content rate by provider.
- Useful-content rate by page type.
- Cost per useful full-content source.

## Success Criteria

The experiment succeeds when it identifies:

- Which providers return usable content.
- Which page types degrade content quality.
- Whether content quality justifies `research` mode cost.
- At least five concrete bad-content examples.

## What We Might Learn

- Jina may be strong for extraction even if search recall is weaker.
- Exa or Tavily may provide better search plus adequate content.
- Parallel may retrieve richer synthesized content but cost/latency may matter.
- Some official pages may defeat all content extractors.

## Results Log

### 2026-06-14 - Codex - 20260614T012424Z-08-full-content-usefulness-pilot

- Commit/worktree: uncommitted/no HEAD
- Commands: `bun --check protoblocks/src/08-full-content-usefulness/run-pilot.ts` (this invocation executed the runner); full provider command list in `protoblocks/src/08-full-content-usefulness/runs/20260614T012424Z-08-full-content-usefulness-pilot/commands.jsonl`
- Providers: exa,parallel,tavily,jina (Full-Content Capable from PROVIDER_SETS.md; no control provider within pilot cap)
- Dataset: 4 fixed pilot cases; news, agency, company investor-relations, structured official page.
- Cost: $0.068
- Key metrics:

| Provider | Sources | Content presence | Median content length | Expected-term hit rate | Useful-content rate | Cost/useful USD | Failure rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exa | 40 | 1 | 6000 | 0.775 | 0.775 | 0.000903 | 0 |
| parallel | 40 | 1 | 1450 | 0.85 | 0.775 | 0.000645 | 0 |
| tavily | 40 | 0.95 | 10098 | 0.85 | 0.85 | 0.000588 | 0 |
| jina | 38 | 0.8947 | 26042 | 0.6579 | 0.6579 | 0 | 0 |

- Interpretation: Pilot shows full-content usefulness varies materially by provider and page type; summary metrics are enough to justify a larger run, not a default change.
- Follow-up: expand to include blog and Polymarket resolution-source page types, then compare source-level usefulness against a non-full-content control.
- Project change justified: none
