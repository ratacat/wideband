import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SweepResult } from '../src/index'
import { redirectFetch } from './fixture-fetch'

const built = process.argv.includes('--dist')
const { wideband, WidebandError, LedgerError } = built ? await import('../dist/index.js') : await import('../src/index')
const providers = ['anyapi', 'brave', 'desearch', 'exa', 'jina', 'linkup', 'nimble', 'parallel', 'perplexity', 'sailor', 'searchx', 'tavily']
const hostnames: Record<string, string> = {
  'api.getanyapi.com': 'anyapi', 'api.search.brave.com': 'brave', 'api.desearch.ai': 'desearch',
  'api.exa.ai': 'exa', 's.jina.ai': 'jina', 'api.linkup.so': 'linkup', 'sdk.nimbleway.com': 'nimble',
  'api.parallel.ai': 'parallel', 'api.perplexity.ai': 'perplexity', 'sailorsearch.dev': 'sailor',
  'searchx.dev': 'searchx', 'api.tavily.com': 'tavily',
}
type RequestRecord = { provider: string; query: string; page: number; body: Record<string, unknown>; url: URL; headers: Record<string, string | string[] | undefined>; finished: boolean; aborted: boolean }
const requests: RequestRecord[] = []
const checks: string[] = []
const pressure = Promise.withResolvers<void>()
const directory = await mkdtemp(join(tmpdir(), 'wideband-e2e-'))
const databasePath = join(directory, 'ledger.sqlite')
const clients: ReturnType<typeof wideband>[] = []
const originalKeys = new Map<string, string | undefined>()
for (const provider of providers) {
  const key = `${provider.toUpperCase()}_API_KEY`
  originalKeys.set(key, process.env[key])
  process.env[key] = 'fixture-secret-password'
}

function rows(provider: string, query: string, page: number) {
  if (query === 'empty') return []
  if (query === 'merge') {
    if (provider === 'brave') return [{ url: 'http://www.example.com/shared?utm_source=brave', title: 'A longer shared title', description: 'A longer useful snippet' }]
    return [{ url: 'https://example.com/shared', title: 'Shared', highlights: ['Short'] }, { url: 'https://example.com/exa-only', title: 'Only Exa' }]
  }
  if (query.startsWith('freshness')) {
    if (provider === 'exa') return [{ url: 'https://example.com/native', title: 'Native date unavailable' }]
    return [
      { url: 'https://example.com/recent', title: 'Recent', publish_date: '2026-06-12T02:00:00.000Z' },
      { url: 'https://example.com/stale', title: 'Stale', publish_date: '2026-06-11T23:00:00.000Z' },
      { url: 'https://example.com/undated', title: 'Undated' },
    ]
  }
  return [{ url: `https://example.com/${provider}/${page}`, title: `${provider} result`, snippet: `${provider} snippet`, extra_fixture_field: 'preserved' }]
}

function responseFor(record: RequestRecord): unknown {
  const { provider, query, page } = record
  const results = rows(provider, query, page)
  if (query === 'image-mapping' && provider === 'linkup') return { results: [{ type: 'text', name: 'Not an image', url: 'https://example.com/text' }, { type: 'image', name: 'Image', url: 'https://example.com/image.png' }] }
  if (query === 'image-mapping' && provider === 'searchx') return { results: [{ title: 'Image', image_url: 'https://example.com/image.png', alt: 'Image description' }] }
  switch (provider) {
    case 'anyapi': return { costUsd: 0.0004, output: { data: { results: results.map(row => ({ ...row, link: row.url })), nextCursor: page === 1 ? 'next' : null } } }
    case 'brave': return { web: { results } }
    case 'desearch': return { data: results.map(row => ({ ...row, link: row.url })) }
    case 'exa': return { results, costDollars: { total: 0.007 } }
    case 'jina': return { data: results.map(row => ({ ...row, description: 'Jina snippet', content: 'Jina full content' })) }
    case 'linkup': return { results: results.map(row => ({ ...row, type: 'text', name: row.title, content: 'Linkup content' })) }
    case 'nimble': return { results: results.map((row, index) => ({ ...row, description: 'Nimble snippet', content: 'Nimble full content', metadata: { position: index + 1, date: '2026-02-03', source: 'Nimble author' } })) }
    case 'parallel': return { results: results.map(row => ({ ...row, excerpts: ['Parallel content'] })) }
    case 'perplexity': return { results }
    case 'sailor': return { results: results.map(row => ({ ...row, markdown: '# Sailor result' })) }
    case 'searchx': return { results }
    case 'tavily': return { results: results.map(row => ({ ...row, content: 'Tavily snippet', raw_content: 'Tavily full content' })) }
    default: throw new Error(`Unexpected provider ${provider}`)
  }
}

const server = createServer(async (request, response) => {
  try {
    const originalUrl = request.headers['x-fixture-url']
    assert.equal(typeof originalUrl, 'string')
    const url = new URL(String(originalUrl))
    const provider = hostnames[url.hostname]
    assert(provider, `Unexpected network target ${url.hostname}`)
    let content = ''
    for await (const chunk of request) content += chunk
    const body: Record<string, unknown> = content ? JSON.parse(content) : {}
    const query = String(body.query ?? body.q ?? body.objective ?? url.searchParams.get('q') ?? url.searchParams.get('query') ?? '')
    const page = typeof body.page === 'number' ? body.page : 1
    const record: RequestRecord = { provider, query, page, body, url, headers: request.headers, finished: false, aborted: false }
    requests.push(record)
    response.once('close', () => { if (!record.finished) record.aborted = true })
    if (query === 'pressure-target') await pressure.promise
    if (query === 'transport-loss') { request.socket.destroy(); return }
    if (query.includes('slow') || query.includes('shared') || query.includes('stream')) await Bun.sleep(provider === 'exa' ? 20 : 180)
    if (response.destroyed) return
    let status = 200
    let payload: unknown = responseFor(record)
    if (query === 'retry' && page === 2 && requests.filter(r => r.query === query && r.page === 2).length === 1) {
      status = 503
      payload = { costUsd: 0, message: 'Temporary fixture failure' }
      response.setHeader('retry-after', '0')
    }
    if (query === 'partial' && page === 2 || query === 'auth') {
      status = 401
      payload = { costUsd: 0, message: 'Invalid key fixture-secret-password' }
    }
    if (query.startsWith('malformed')) payload = { costUsd: 0.0004, unexpected: 'shape' }
    if (query === 'quota429') {
      status = 429
      payload = { costUsd: 0, message: 'Insufficient credits' }
      response.setHeader('retry-after', '30')
    }
    if (query === 'not-found') payload = { costUsd: 0.0004, output: { found: false, data: null, reason: 'not_found' } }
    response.writeHead(status, { 'content-type': 'application/json' })
    record.finished = true
    response.end(JSON.stringify(payload))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const restoreFetch = redirectFetch(origin)
const wb = wideband({ db: databasePath })
clients.push(wb)

function matching(query: string, provider = 'anyapi') { return requests.filter(record => record.query === query && record.provider === provider) }
function checked(name: string) { checks.push(name); process.stdout.write(`${name}\n`) }
async function rejected(promise: Promise<unknown>) {
  try { await promise } catch (error) { assert(error instanceof Error); return error }
  assert.fail('Expected the operation to reject')
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert(Date.now() < deadline, 'Fixture condition timed out'); await Bun.sleep(5) }
}
async function cli(args: string[], db = databasePath) {
  const child = Bun.spawn(['bun', '--preload', './testing/fixture-fetch.ts', built ? 'dist/cli/main.js' : 'src/cli/main.ts', ...args], {
    cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, WIDEBAND_FIXTURE_ORIGIN: origin, WIDEBAND_DB: db },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

function attempts(query: string, path = databasePath) {
  const database = new Database(path, { readonly: true })
  try {
    return database.query<{ status: string; charge_kind: string; charge_micro_usd: number | null; estimate_micro_usd: number }, [string]>("SELECT attempts.status,charge_kind,charge_micro_usd,estimate_micro_usd FROM attempts JOIN sweeps ON sweeps.id=attempts.sweep_id WHERE json_extract(sweeps.query_json,'$.q')=? ORDER BY attempts.rowid").all(query)
  } finally { database.close() }
}

try {
  const mapped = await wb.scan({ q: 'mapping', max: 1 }, { providers, fresh: true })
  assert.deepEqual(Object.values(mapped.stats.providers).map(value => value.status), Array(12).fill('ok'))
  assert.equal(mapped.sources.length, 12)
  assert.deepEqual([...new Set(mapped.sources.flatMap(source => source.providers))].sort(), [...providers].sort())
  assert.equal(matching('mapping', 'anyapi')[0]?.headers.authorization, 'Bearer fixture-secret-password')
  assert.equal(matching('mapping', 'exa')[0]?.body.type, 'fast')
  assert.equal(matching('mapping', 'parallel')[0]?.body.mode, 'basic')
  assert.equal(matching('mapping', 'tavily')[0]?.body.search_depth, 'basic')
  assert.equal(matching('mapping', 'jina')[0]?.headers['x-respond-with'], 'no-content')
  assert.equal(matching('mapping', 'searchx')[0]?.url.searchParams.get('mode'), 'keyword')
  assert.equal(matching('mapping', 'nimble')[0]?.url.pathname, '/v2/search')
  assert.deepEqual(matching('mapping', 'nimble')[0]?.body, { query: 'mapping', focus: 'general', max_results: 1, search_depth: 'lite' })
  const nimbleSource = mapped.sources.find(source => source.providers.includes('nimble'))
  assert.equal(nimbleSource?.snippet, 'Nimble snippet')
  assert.equal(nimbleSource?.publishedAt, '2026-02-03')
  assert.equal(nimbleSource?.author, 'Nimble author')
  assert.equal(nimbleSource?.content, undefined)
  checked('All twelve HTTP adapters validate and normalize real HTTP responses')

  const rich = await wb.research({ q: 'research-mapping', max: 2 }, { providers: ['exa', 'parallel', 'tavily', 'jina', 'linkup', 'sailor', 'searchx', 'nimble'], fresh: true })
  assert.equal(rich.sources.length, 8)
  assert.equal(matching('research-mapping', 'exa')[0]?.body.type, 'auto')
  assert.deepEqual(matching('research-mapping', 'exa')[0]?.body.contents, { highlights: true, text: { maxCharacters: 6000 } })
  assert.equal(matching('research-mapping', 'parallel')[0]?.body.mode, 'advanced')
  assert.equal(matching('research-mapping', 'tavily')[0]?.body.search_depth, 'advanced')
  assert.equal(matching('research-mapping', 'tavily')[0]?.body.include_raw_content, 'markdown')
  assert.equal(matching('research-mapping', 'linkup')[0]?.body.depth, 'standard')
  assert.equal(matching('research-mapping', 'sailor')[0]?.body.search_mode, 'advanced')
  assert.equal(matching('research-mapping', 'searchx')[0]?.url.searchParams.get('mode'), 'hybrid')
  assert.equal(matching('research-mapping', 'nimble')[0]?.url.pathname, '/v2/search')
  assert.deepEqual(matching('research-mapping', 'nimble')[0]?.body, { query: 'research-mapping', focus: 'general', max_results: 2, search_depth: 'deep' })
  assert.equal(rich.sources.find(source => source.providers.includes('nimble'))?.content, 'Nimble full content')
  assert.equal(rich.sources.find(source => source.providers.includes('jina'))?.content, 'Jina full content')
  checked('Research preserves provider depth, request formats and full-content behavior')

  const filtered = await wb.scan({ q: 'news-filter', max: 3, mediaType: 'news', freshness: { after: '2026-01-01T05:06:07.000Z', before: '2026-01-31T23:59:59.000Z' }, domains: { include: ['example.com'], exclude: ['spam.example'] } }, { providers: ['tavily', 'parallel'], fresh: true })
  assert.equal(filtered.stats.providers.parallel?.status, 'skipped:capability')
  assert.equal(matching('news-filter', 'parallel').length, 0)
  assert.deepEqual(matching('news-filter', 'tavily')[0]?.body, { query: 'news-filter', max_results: 3, search_depth: 'basic', include_answer: false, include_raw_content: false, topic: 'news', start_date: '2026-01-01', end_date: '2026-01-31', include_domains: ['example.com'], exclude_domains: ['spam.example'] })
  const images = await wb.scan({ q: 'image-mapping', mediaType: 'image' }, { providers: ['linkup', 'searchx', 'exa'], fresh: true })
  assert.equal(images.sources.length, 1)
  assert.equal(images.sources[0]?.mediaType, 'image')
  assert.deepEqual([...(images.sources[0]?.providers ?? [])].sort(), ['linkup', 'searchx'])
  assert.equal(images.stats.providers.exa?.status, 'skipped:capability')
  assert.equal(matching('image-mapping', 'searchx')[0]?.url.pathname, '/api/v1/images/search')
  checked('Capabilities and domain, date, news and image filters retain their provider contracts')

  const invalidAll = await rejected(wb.scan('malformed-all', { providers, fresh: true }))
  assert(invalidAll instanceof WidebandError)
  assert.equal(invalidAll.code, 'ALL_PROVIDERS_FAILED')
  assert(invalidAll.result)
  assert.deepEqual(Object.values(invalidAll.result.stats.providers).map(value => value.error?.code), Array(12).fill('invalid_response'))
  checked('Every HTTP adapter rejects a missing result envelope rather than reporting empty success')

  const merged = await wb.scan('merge', { providers: ['brave', 'exa'], fresh: true })
  assert.deepEqual(merged.sources.map(source => source.url), ['https://example.com/shared', 'https://example.com/exa-only'])
  assert.deepEqual([...merged.sources[0]!.providers].sort(), ['brave', 'exa'])
  assert.equal(merged.sources[0]!.title, 'A longer shared title')
  assert.equal(merged.sources[0]!.score, 0.032786885)
  checked('Canonical URLs, metadata, provenance and reciprocal rank fusion survive the redesign')

  for (const policy of ['strict', 'balanced', 'recall'] as const) {
    const result = await wb.scan({ q: `freshness-${policy}`, freshness: { after: '2026-06-12T01:28:00.000Z' }, freshnessPolicy: policy }, { providers: ['exa', 'parallel'], fresh: true })
    const expected = policy === 'strict' ? ['native', 'recent'] : policy === 'balanced' ? ['native', 'recent', 'undated'] : ['native', 'recent', 'stale', 'undated']
    assert.deepEqual(result.sources.map(source => source.url.split('/').at(-1)).sort(), expected)
  }
  checked('Strict, balanced and recall freshness policies preserve observed behavior')

  const budgeted = await wb.scan({ q: 'budget', googlePages: 2, max: 20 }, { providers: ['anyapi'], budget: 0.0009, fresh: true })
  assert.equal(budgeted.sources.length, 1)
  assert.equal(budgeted.complete, false)
  assert.equal(budgeted.cost.totalUSD, 0.0004)
  assert.deepEqual(matching('budget').map(record => record.page), [1])
  checked('A one-page budget prevents a second billable dispatch')

  const retry = await wb.scan({ q: 'retry', googlePages: 2, max: 20 }, { providers: ['anyapi'], fresh: true })
  assert.deepEqual(matching('retry').map(record => record.page), [1, 2, 2])
  assert.equal(retry.sources.length, 2)
  assert.equal(retry.cost.totalUSD, 0.0008)
  assert.equal(retry.stats.providers.anyapi?.attempts, 3)
  checked('A failed page retries alone and every response charge is retained')

  const partial = await wb.scan({ q: 'partial', googlePages: 2, max: 20 }, { providers: ['anyapi'] })
  assert.equal(partial.sources.length, 1)
  assert.equal(partial.stats.providers.anyapi?.status, 'partial')
  assert.equal(partial.complete, false)
  assert.equal(partial.cost.totalUSD, 0.0004)
  await wb.scan({ q: 'partial', googlePages: 2, max: 20 }, { providers: ['anyapi'] })
  assert.deepEqual(matching('partial').map(record => record.page), [1, 2, 1, 2])
  checked('Incomplete providers retain earlier hits and usage without poisoning the cache')

  const malformed = await rejected(wb.scan('malformed', { providers: ['anyapi'] }))
  assert.match(malformed.message, /provider|response|failed/i)
  await rejected(wb.scan('malformed', { providers: ['anyapi'] }))
  assert.equal(matching('malformed').length, 2)
  const auth = await rejected(wb.scan('auth', { providers: ['anyapi'] }))
  assert(!JSON.stringify(auth).includes('fixture-secret-password'))
  checked('Malformed responses and total provider failure reject and are never cached')

  await rejected(wb.scan('quota429', { providers: ['anyapi'], fresh: true }))
  assert.equal(matching('quota429').length, 1)
  const afterQuota = await wb.scan('after-quota', { providers: ['anyapi'], fresh: true, timeoutMs: 1000 })
  assert.equal(afterQuota.sources.length, 1)
  checked('Quota exhaustion is distinct from rate limiting even when the HTTP status is 429')

  const omitted = await wb.sweep({ q: 'undefined-optionals', mode: undefined, mediaType: undefined, max: undefined, googlePages: undefined, freshnessPolicy: undefined, freshness: { after: undefined, before: undefined }, domains: { include: undefined, exclude: undefined } }, { providers: ['brave'], budget: undefined, timeoutMs: undefined, session: undefined, fresh: undefined, ttlSec: undefined, capture: undefined })
  assert.equal(omitted.query.mode, 'scan')
  assert.equal(omitted.query.mediaType, 'web')
  assert.equal(omitted.query.max, 10)
  assert.equal(omitted.query.freshnessPolicy, 'balanced')
  assert.deepEqual(omitted.query.freshness, {})
  assert.deepEqual(omitted.query.domains, {})
  assert.equal(omitted.sources.length, 1)
  checked('Explicit undefined SDK properties retain omission and default behavior')

  const empty = await wb.scan('empty', { providers: ['anyapi'] })
  const emptyAgain = await wb.scan('empty', { providers: ['anyapi'] })
  assert.equal(empty.sources.length, 0)
  assert.equal(empty.complete, true)
  assert.equal(emptyAgain.cached, true)
  assert.equal(emptyAgain.cost.totalUSD, 0)
  assert.equal(matching('empty').length, 1)
  checked('Valid empty searches remain cacheable at zero repeat cost')
  const notFound = await wb.scan('not-found', { providers: ['anyapi'], fresh: true })
  assert.equal(notFound.sources.length, 0)
  assert.equal(notFound.complete, true)
  checked('The provider explicit not-found response is a valid empty search')

  const captured = await wb.scan('capture', { providers: ['anyapi'], capture: true })
  const stripped = await wb.scan('capture', { providers: ['anyapi'] })
  assert(captured.sources[0]?.raw)
  assert.equal(stripped.sources[0]?.raw, undefined)
  assert.equal(matching('capture').length, 2)
  checked('Captured and stripped responses use separate cache entries')

  const abortOne = new AbortController()
  const first = rejected(wb.scan('shared-cancel', { providers: ['anyapi'], signal: abortOne.signal }))
  const second = wb.scan('shared-cancel', { providers: ['anyapi'] })
  await waitFor(() => matching('shared-cancel').length === 1)
  abortOne.abort()
  await first
  const survivor = await second
  assert.equal(survivor.sources.length, 1)
  assert.equal(matching('shared-cancel').length, 1)
  checked('Cancelling one caller preserves a coalesced search for another caller')

  const oldest = wb.scan('pressure-target', { providers: ['anyapi'] })
  await waitFor(() => matching('pressure-target').length === 1)
  const others = Array.from({ length: 128 }, (_, index) => wb.scan(`pressure-${index}`, { providers: ['anyapi'] }))
  const pressureDatabase = new Database(databasePath, { readonly: true })
  try {
    const countSweeps = pressureDatabase.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sweeps WHERE json_extract(query_json,'$.q') LIKE 'pressure-%'")
    await waitFor(() => countSweeps.get()?.count === 129)
    const late = wb.scan('pressure-target', { providers: ['anyapi'] })
    const abandoned = new AbortController()
    const follower = rejected(wb.scan('pressure-target', { providers: ['anyapi'], signal: abandoned.signal }))
    await Bun.sleep(20)
    abandoned.abort()
    await follower
    pressure.resolve()
    const [original, joined] = await Promise.all([oldest, late])
    await Promise.all(others)
    assert.equal(original.sweepId, joined.sweepId)
    assert.deepEqual(original.sources, joined.sources)
    assert.equal(matching('pressure-target').length, 1)
    assert.equal(countSweeps.get()?.count, 129)
    const totals = pressureDatabase.query<{ attempts: number; microUSD: number }, []>("SELECT COUNT(*) AS attempts,SUM(charge_micro_usd) AS microUSD FROM attempts JOIN sweeps ON sweeps.id=attempts.sweep_id WHERE json_extract(sweeps.query_json,'$.q') LIKE 'pressure-%'").get()
    assert.deepEqual(totals, { attempts: 129, microUSD: 51600 })
  } finally { pressureDatabase.close() }
  checked('Active searches keep sharing under cache pressure without duplicate billable requests')

  const [sessionOne, sessionTwo] = await Promise.all([
    wb.scan('shared-session', { providers: ['anyapi'], session: 'same-session' }),
    wb.scan('shared-session', { providers: ['anyapi'], session: 'same-session' }),
  ])
  assert.equal(sessionOne.sources.length + sessionTwo.sources.length, 1)
  assert.equal(matching('shared-session').length, 1)
  const independentSession = await wb.scan('shared-session', { providers: ['anyapi'], session: 'other-session' })
  assert.equal(independentSession.sources.length, 1)
  checked('Session claims are atomic per caller and isolated from shared retrieval')

  await Promise.all([wb.scan('fresh-shared', { providers: ['anyapi'], fresh: true }), wb.scan('fresh-shared', { providers: ['anyapi'], fresh: true })])
  assert.equal(matching('fresh-shared').length, 2)
  checked('Fresh searches bypass both persistent cache and in-flight sharing')

  const batch = wb.scan('stream-shared', { providers: ['exa', 'anyapi'] })
  let final: SweepResult | undefined
  let early = false
  for await (const event of wb.stream('stream-shared', { providers: ['exa', 'anyapi'] })) {
    if (event.kind === 'provider' && event.provider === 'exa') early = !matching('stream-shared')[0]?.finished
    if (event.kind === 'result') final = event.result
  }
  const complete = await batch
  assert(early, 'Fast provider results waited for the slow provider')
  assert(final)
  assert.equal(final.sweepId, complete.sweepId)
  assert.deepEqual(final.sources, complete.sources)
  assert.equal(matching('stream-shared').length, 1)
  checked('Streaming delivers early results and shares the exact final batch result')

  await rejected(wb.scan('transport-loss', { providers: ['anyapi'], fresh: true }))
  assert.equal(matching('transport-loss').length, 1)
  assert.deepEqual(attempts('transport-loss').map(row => [row.charge_kind, row.charge_micro_usd, row.estimate_micro_usd]), [['unknown', null, 900]])
  checked('A lost response does not automatically repeat potentially charged work')

  const stopped = new AbortController()
  const cancelled = rejected(wb.scan('slow-abort', { providers: ['anyapi'], fresh: true, signal: stopped.signal }))
  await waitFor(() => matching('slow-abort').length === 1)
  stopped.abort()
  await cancelled
  await waitFor(() => matching('slow-abort')[0]?.aborted === true)
  assert.deepEqual(attempts('slow-abort').map(row => [row.status, row.charge_kind]), [['cancelled', 'unknown']])
  checked('Parent cancellation reaches the actual HTTP connection')

  const wire = await cli(['scan', 'cli-pages', '--providers', 'anyapi', '--google-pages', '2', '--fresh', '--full'])
  assert.equal(wire.code, 0, wire.stderr)
  const output = JSON.parse(wire.stdout)
  assert.equal(output.query.max, 20)
  assert.equal(output.sources.length, 2)
  assert(matching('cli-pages').every(record => record.headers.authorization === 'Bearer fixture-secret-password'))
  for (const value of ['0', '11', '1.5']) {
    const invalid = await cli(['scan', 'invalid', '--providers', 'anyapi', '--google-pages', value])
    assert.equal(invalid.code, 2)
    assert.match(invalid.stderr, /INVALID_ARGS/)
  }
  checked('CLI pagination defaults and argument errors retain their wire contract')

  const streamed = await cli(['scan', 'cli-stream', '--providers', 'exa,anyapi', '--stream', '--full', '--fresh'])
  assert.equal(streamed.code, 0, streamed.stderr)
  const events = streamed.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events[0].kind, 'provider')
  assert.equal(events[0].provider, 'exa')
  assert.equal(events.at(-1).kind, 'result')
  assert.equal(events.at(-1).result.sources.length, 2)
  const schema = await cli(['schema', 'UnifiedQuery'])
  assert.equal(schema.code, 0, schema.stderr)
  const querySchema = JSON.parse(schema.stdout)
  assert.equal(querySchema.properties.max.type, 'integer')
  assert.equal(querySchema.properties.max.maximum, 100)
  checked('CLI streaming emits NDJSON and its query schema preserves finite integer bounds')

  const failurePath = join(directory, 'storage-failure.sqlite')
  const faulty = wideband({ db: failurePath })
  clients.push(faulty)
  await faulty.providers()
  const databaseFault = new Database(failurePath)
  try {
    databaseFault.run("CREATE TRIGGER reject_attempt BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT,'fixture cannot record attempt'); END")
    await rejected(faulty.scan('blocked-ledger', { providers: ['anyapi'], fresh: true }))
    assert.equal(matching('blocked-ledger').length, 0)
    databaseFault.run('DROP TRIGGER reject_attempt')
    databaseFault.run("CREATE TRIGGER reject_summary BEFORE UPDATE ON sweeps BEGIN SELECT RAISE(ABORT,'fixture cannot update summary'); END")
    await rejected(faulty.scan('failed-summary', { providers: ['anyapi'], fresh: true }))
    assert.equal(matching('failed-summary').length, 1)
    assert.deepEqual(attempts('failed-summary', failurePath).map(row => [row.status, row.charge_kind, row.charge_micro_usd]), [['ok', 'observed', 400]])
    const afterFailure = await faulty.costs()
    assert.equal(afterFailure.totalUSD, 0.0004)
    databaseFault.run('DROP TRIGGER reject_summary')
    databaseFault.run("CREATE TRIGGER reject_finish BEFORE UPDATE ON attempts BEGIN SELECT RAISE(FAIL,'fixture cannot settle attempt'); END")
    const unsettled = await rejected(faulty.scan('failed-finish', { providers: ['anyapi'], fresh: true }))
    assert(unsettled instanceof LedgerError)
    assert.equal(unsettled.operation, 'finishAttempt')
    assert.deepEqual(unsettled.attempt?.charge, { kind: 'observed', microUSD: 400 })
    assert.deepEqual(attempts('failed-finish', failurePath).map(row => [row.status, row.charge_kind, row.charge_micro_usd, row.estimate_micro_usd]), [['pending', 'unknown', null, 900]])
    assert.equal((await faulty.costs()).unknownAttempts, 1)
    databaseFault.run('DROP TRIGGER reject_finish')
  } finally { databaseFault.close() }
  checked('Storage failures prevent unrecorded dispatch and retain both settled and uncertain charges')

  const legacyPath = join(directory, 'legacy.sqlite')
  const legacy = new Database(legacyPath)
  legacy.run('CREATE TABLE sweeps (id TEXT PRIMARY KEY,ts INTEGER,kind TEXT,query_json TEXT,total_hits INTEGER,unique_sources INTEGER,total_usd REAL,total_ms INTEGER)')
  legacy.run('CREATE TABLE calls (sweep_id TEXT,provider TEXT,status TEXT,hits INTEGER,unique_contributed INTEGER,latency_ms INTEGER,usd REAL,cost_basis TEXT,error_code TEXT)')
  legacy.prepare('INSERT INTO sweeps VALUES (?,?,?,?,?,?,?,?)').run('legacy-sweep', Date.now(), 'sweep', '{}', 1, 1, 0.012, 100)
  legacy.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?)').run('legacy-sweep', 'legacy_fixture', 'ok', 1, 1, 100, 0.012, 'metered', null)
  legacy.close()
  const migrated = await Promise.all(Array.from({ length: 4 }, () => cli(['costs'], legacyPath)))
  for (const result of migrated) {
    assert.equal(result.code, 0, result.stderr)
    const history = JSON.parse(result.stdout)
    assert.equal(history.totalUSD, 0.012)
    assert.equal(history.providers.legacy_fixture.attempts, 1)
  }
  checked('Concurrent CLI processes migrate a legacy ledger without losing historical spend')

  const freshRows = attempts('fresh-shared')
  assert.equal(freshRows.length, 2)
  assert.equal(attempts('shared-cancel').length, 1)
  assert.equal(attempts('stream-shared').length, 2)
  assert.deepEqual(attempts('retry').map(row => row.charge_micro_usd), [400, 0, 400])
  assert.deepEqual(attempts('malformed').map(row => row.charge_micro_usd), [400, 400])
  checked('Durable attempts count shared execution once and preserve charges independently of hit validation')

  const closing = wideband({ db: join(directory, 'closing.sqlite') })
  clients.push(closing)
  const active = rejected(closing.scan('slow-shutdown', { providers: ['anyapi'], fresh: true }))
  await waitFor(() => matching('slow-shutdown').length === 1)
  await Promise.all([closing.close(), closing.close()])
  await active
  await rejected(closing.scan('after-close', { providers: ['anyapi'] }))
  assert.equal(matching('after-close').length, 0)
  checked('SDK close cancels active work, releases resources and rejects new work')

  const costs = await wb.costs()
  assert(costs.totalUSD > 0)
  const database = new Database(databasePath, { readonly: true })
  const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
  assert(tables.includes('sweeps'))
  database.close()
  checked('Persistent ledger remains queryable after real searches')
} finally {
  pressure.resolve()
  await Promise.all(clients.map(client => client.close()))
  restoreFetch()
  for (const [key, value] of originalKeys) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ passed: checks.length })}\n`)
