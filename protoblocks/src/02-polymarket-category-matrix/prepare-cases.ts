// @ts-nocheck
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

type GammaTag = { label?: string; slug?: string }
type GammaMarket = {
  id?: string | number
  question?: string
  slug?: string
  active?: boolean
  closed?: boolean
  resolutionSource?: string
  category?: string | null
}
type GammaEvent = {
  id?: string | number
  title?: string
  slug?: string
  active?: boolean
  closed?: boolean
  resolutionSource?: string
  tags?: GammaTag[]
  markets?: GammaMarket[]
}

const runDir = process.argv[2]
if (!runDir) {
  throw new Error('usage: bun prepare-cases.ts <run-dir>')
}

const preferredCategories = ['politics', 'crypto', 'sports', 'macro', 'culture', 'weather']
const sourceFiles = ['gamma-events-offset-0.json', 'gamma-events-offset-100.json', 'gamma-events-offset-200.json']

function words(value: string | undefined | null) {
  return (value ?? '').toLowerCase()
}

function tagText(event: GammaEvent) {
  return (event.tags ?? []).map((tag) => `${tag.label ?? ''} ${tag.slug ?? ''}`).join(' ').toLowerCase()
}

function classify(question: string, event: GammaEvent, market: GammaMarket) {
  const q = words(`${question} ${event.title ?? ''} ${market.category ?? ''}`)
  const tags = tagText(event)
  const haystack = `${q} ${tags}`

  if (/\b(cpi|fed rate|fed rates|rate cut|rates|inflation|gdp|unemployment|jobs|recession|treasury|econom(y|ics))\b/.test(q)) return 'macro'
  if (/\b(weather|temperature|hurricane|rain|snow|climate|tornado|wildfire)\b/.test(q)) return 'weather'
  if (/\b(movie|album|box office|oscar|grammy|celebrity|music|streaming|netflix|spotify)\b/.test(q)) return 'culture'
  if (/\b(election|trump|biden|senate|congress|president|minister|party|nato|ukraine|macron|starmer|politics?)\b/.test(haystack)) return 'politics'
  if (/\b(bitcoin|btc|ethereum|eth|solana|crypto|token|kraken|xrp|doge)\b/.test(haystack)) return 'crypto'
  if (/\b(nfl|nba|mlb|nhl|ufc|soccer|match|game|championship|world cup|tennis|fifa|sports?)\b/.test(haystack)) return 'sports'
  return 'other'
}

function host(value: string | undefined) {
  if (!value) return undefined
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function caseId(category: string, market: GammaMarket) {
  const base = String(market.slug || market.id || market.question || 'case')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  return `${category}-${base}`
}

const events = sourceFiles.flatMap((file) => {
  const raw = readFileSync(join(runDir, file), 'utf8')
  return JSON.parse(raw) as GammaEvent[]
})

const byCategory = new Map<string, ReturnType<typeof buildCase>[]>()
const counts: Record<string, { candidates: number; selected: number; withResolutionSource: number }> = {}
const seenMarkets = new Set<string>()

function buildCase(event: GammaEvent, market: GammaMarket, category: string) {
  const resolutionSource = market.resolutionSource || event.resolutionSource || ''
  const expectedDomain = host(resolutionSource)
  return {
    id: caseId(category, market),
    q: market.question ?? '',
    tags: ['polymarket', category, 'pilot'],
    category,
    ...(expectedDomain ? { expectedDomains: [expectedDomain] } : {}),
    ...(resolutionSource ? { expectedUrls: [resolutionSource] } : {}),
    market: {
      eventId: event.id === undefined ? undefined : String(event.id),
      eventSlug: event.slug,
      eventTitle: event.title,
      marketId: market.id === undefined ? undefined : String(market.id),
      marketSlug: market.slug,
      resolutionSource,
      gammaTags: (event.tags ?? []).map((tag) => tag.slug ?? tag.label).filter(Boolean),
    },
  }
}

for (const event of events) {
  for (const market of event.markets ?? []) {
    if (!market.question) continue
    if (event.active === false || event.closed === true) continue
    if (market.active === false || market.closed === true) continue
    const key = String(market.id ?? market.slug ?? market.question)
    if (seenMarkets.has(key)) continue
    seenMarkets.add(key)

    const category = classify(market.question, event, market)
    const candidate = buildCase(event, market, category)
    const bucket = byCategory.get(category) ?? []
    bucket.push(candidate)
    byCategory.set(category, bucket)

    counts[category] ??= { candidates: 0, selected: 0, withResolutionSource: 0 }
    counts[category].candidates += 1
    if (candidate.market.resolutionSource) counts[category].withResolutionSource += 1
  }
}

const selected = preferredCategories
  .map((category) => byCategory.get(category)?.[0])
  .filter((value): value is ReturnType<typeof buildCase> => Boolean(value))
  .slice(0, 5)

for (const item of selected) {
  counts[item.category].selected += 1
}

if (selected.length < 5) {
  throw new Error(`expected 5 cases, only selected ${selected.length}`)
}

writeFileSync(join(runDir, 'cases.jsonl'), selected.map((item) => JSON.stringify(item)).join('\n') + '\n')
writeFileSync(
  join(runDir, 'candidate-summary.json'),
  JSON.stringify(
    {
      sourceFiles: sourceFiles.map((file) => basename(file)),
      totalEvents: events.length,
      totalOpenMarkets: [...byCategory.values()].reduce((sum, bucket) => sum + bucket.length, 0),
      counts,
      selectedCaseIds: selected.map((item) => item.id),
    },
    null,
    2,
  ) + '\n',
)

writeFileSync(
  join(runDir, 'sampling.md'),
  `# Sampling

- Sampled at: ${new Date().toISOString()}
- Source endpoints:
  - https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=0
  - https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=100
  - https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=200
- Filters: event active != false, event closed != true, market active != false, market closed != true, non-empty market question.
- Case cap: 5.
- Category rule: explicit tag/question keyword rules matching politics, crypto, sports, macro, weather, culture, then other.
- Selection rule: first available open market in each preferred category order; stop at 5 categories for the pilot.
- Preferred category order: ${preferredCategories.join(', ')}.
- Exclusions: duplicate market IDs/slugs/questions and closed/inactive markets.

## Classification Rules

\`\`\`ts
if (/\\b(cpi|fed rate|fed rates|rate cut|rates|inflation|gdp|unemployment|jobs|recession|treasury|econom(y|ics))\\b/.test(questionAndTitle)) return 'macro'
if (/\\b(weather|temperature|hurricane|rain|snow|climate|tornado|wildfire)\\b/.test(questionAndTitle)) return 'weather'
if (/\\b(movie|album|box office|oscar|grammy|celebrity|music|streaming|netflix|spotify)\\b/.test(questionAndTitle)) return 'culture'
if (/\\b(election|trump|biden|senate|congress|president|minister|party|nato|ukraine|macron|starmer|politics?)\\b/.test(questionTitleAndTags)) return 'politics'
if (/\\b(bitcoin|btc|ethereum|eth|solana|crypto|token|kraken|xrp|doge)\\b/.test(questionTitleAndTags)) return 'crypto'
if (/\\b(nfl|nba|mlb|nhl|ufc|soccer|match|game|championship|world cup|tennis|fifa|sports?)\\b/.test(questionTitleAndTags)) return 'sports'
\`\`\`
`,
)
