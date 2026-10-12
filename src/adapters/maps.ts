import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Effect, Option, Result, Schema } from 'effect'
import { proxyUrls, recordTry } from '../google-search.mjs'
import DEFAULT_PB from '../maps-pb.json' with { type: 'json' }
import { AdapterError } from '../core/errors'
import { canonicalizeUrl } from '../core/merge'
import type { Hit, ProviderAdapter } from '../core/types'
import { HttpUrl } from './http'

const PAGE_SIZE = 20
const ATTEMPTS = 3
const TRY_TIMEOUT_MS = 20_000
const PAGE_TIMEOUT_MS = 50_000
const PB_FILE = join(homedir(), '.wideband', 'maps-pb.txt')
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip',
}

const Place = Schema.Struct({
  name: Schema.String,
  placeId: Schema.String,
  address: Schema.optionalKey(Schema.String),
  website: Schema.optionalKey(HttpUrl),
  lat: Schema.optionalKey(Schema.Finite),
  lng: Schema.optionalKey(Schema.Finite),
  category: Schema.optionalKey(Schema.String),
  phone: Schema.optionalKey(Schema.String),
})
type Place = typeof Place.Type

const PLACE_PATHS: Record<keyof Place, readonly number[]> = {
  name: [11],
  placeId: [78],
  address: [39],
  website: [7, 0],
  lat: [9, 2],
  lng: [9, 3],
  category: [13, 0],
  phone: [178, 0, 0],
}
const LIST_PATH = [64]
const LIST_ENTRY_PATH = [1]
const LIST_MODE_PATH = [0, 1, 0, 10]
const SINGLE_PLACE_PATH = [0, 1, 0, 14]

type Outcome = 'ok' | 'blocked' | 'http' | 'transport' | 'drift'
type Fetched = { status: number; location: string; text: string; bytes: number }

function at(value: unknown, path: readonly number[]): unknown {
  return path.reduce<unknown>((node, index) => (Array.isArray(node) ? node[index] : undefined), value)
}

function decodePlace(entry: unknown): Place[] {
  const fields = Object.entries(PLACE_PATHS).flatMap(([field, path]) => {
    const value = at(entry, path)
    return value === null || value === undefined ? [] : [[field, value]]
  })
  return Option.toArray(Schema.decodeUnknownOption(Place)(Object.fromEntries(fields)))
}

function parsePlaces(text: string): Result.Result<Place[], string> {
  if (!text.startsWith(")]}'")) return Result.fail('missing )]}\' prefix')
  let data: unknown
  try {
    data = JSON.parse(text.slice(4))
  } catch {
    return Result.fail('invalid JSON')
  }
  if (!Array.isArray(data)) return Result.fail('not a JSON array')
  const list = at(data, LIST_PATH)
  const single = at(data, SINGLE_PLACE_PATH)
  const entries = Array.isArray(list) ? list.map(entry => at(entry, LIST_ENTRY_PATH)) : Array.isArray(single) ? [single] : []
  if (!entries.length && Array.isArray(at(data, LIST_MODE_PATH))) return Result.fail('list response without data[64]')
  const places = entries.flatMap(decodePlace)
  return entries.length && !places.length ? Result.fail('no entry decodes as a place') : Result.succeed(places)
}

function placesUrl(query: string, offset: number, pb: string): string {
  const pbQuery = query.replace(/[*!]/g, char => (char === '*' ? '*2A' : '*21'))
  const head = `!1s${pbQuery}!7i${PAGE_SIZE}${offset ? `!8i${offset}` : ''}`
  return `https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=us&q=${encodeURIComponent(query)}&pb=${encodeURIComponent(head + pb)}`
}

function readTemplate(): string {
  try {
    const pb = readFileSync(PB_FILE, 'utf8').trim()
    if (pb.startsWith('!')) return pb
  } catch {}
  return DEFAULT_PB
}

function writeTemplate(pb: string) {
  mkdirSync(join(homedir(), '.wideband'), { recursive: true })
  const temporary = `${PB_FILE}.${process.pid}`
  writeFileSync(temporary, `${pb}\n`)
  renameSync(temporary, PB_FILE)
}

function get(url: string, proxy: string, accept: string): Effect.Effect<Fetched | undefined> {
  return Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, {
        proxy,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRY_TIMEOUT_MS)]),
        redirect: 'manual',
        decompress: false,
        headers: { ...HEADERS, accept },
      })
      const body = Buffer.from(await response.arrayBuffer())
      const text = response.headers.get('content-encoding') === 'gzip' ? gunzipSync(body).toString('utf8') : body.toString('utf8')
      const headerBytes = [...response.headers].reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0)
      return { status: response.status, location: response.headers.get('location') ?? '', text, bytes: url.length + headerBytes + body.length }
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))
}

function classify(fetched: Fetched | undefined): { outcome: Exclude<Outcome, 'ok'>; reason: string } | { outcome: 'ok'; places: Place[] } {
  if (!fetched) return { outcome: 'transport', reason: 'proxy connection failed' }
  if (fetched.status === 429 || fetched.location.includes('/sorry')) return { outcome: 'blocked', reason: `HTTP ${fetched.status}` }
  if (fetched.status !== 200) return { outcome: 'http', reason: `HTTP ${fetched.status}` }
  const parsed = parsePlaces(fetched.text)
  return Result.isSuccess(parsed) ? { outcome: 'ok', places: parsed.success } : { outcome: 'drift', reason: parsed.failure }
}

function record(query: string, attempt: number, outcome: string, bytes: number | null, proxy: string) {
  return Effect.tryPromise(() => recordTry({ route: 'maps', query, attempt, outcome, ip: null, bytes, proxy: new URL(proxy).host, family: null, agent: null })).pipe(Effect.ignore)
}

function refreshTemplate(query: string, proxy: string, attempt: number): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const page = yield* get(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=us`, proxy, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    const href = page?.status === 200 ? /href="(\/search\?tbm=map[^"]+)"/.exec(page.text)?.[1]?.replaceAll('&amp;', '&') : undefined
    const pb = href ? new URL(href, 'https://www.google.com').searchParams.get('pb') : undefined
    const renewed = pb?.match(/^!1s[^!]*!7i\d+(?:!8i\d+)?(!.+)$/)?.[1]
    yield* record(query, attempt, renewed ? 'refresh' : 'refresh_failed', page?.bytes ?? null, proxy)
    if (renewed) yield* Effect.try(() => writeTemplate(renewed)).pipe(Effect.ignore)
    return renewed
  })
}

function searchPage(query: string, offset: number): Effect.Effect<Place[], AdapterError> {
  return Effect.gen(function* () {
    const proxies = yield* Effect.try({
      try: () => proxyUrls(),
      catch: error => new AdapterError('provider_error', `Maps proxy inventory: ${error instanceof Error ? error.message : 'unreadable'}`),
    })
    if (!proxies.length) return yield* Effect.fail(new AdapterError('provider_error', 'Maps proxy inventory is empty'))
    const failures: string[] = []
    let pb = readTemplate()
    let refreshed = false
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const proxy = proxies[Math.floor(Math.random() * proxies.length)]!
      const fetched = yield* get(placesUrl(query, offset, pb), proxy, '*/*')
      const verdict = classify(fetched)
      yield* record(query, attempt, verdict.outcome, fetched?.bytes ?? null, proxy)
      if (verdict.outcome === 'ok') return verdict.places
      failures.push(`${verdict.outcome} (${verdict.reason})`)
      if (verdict.outcome !== 'drift') continue
      if (refreshed) break
      refreshed = true
      const renewed = yield* refreshTemplate(query, proxy, attempt)
      if (!renewed) break
      pb = renewed
    }
    return yield* Effect.fail(Object.assign(
      new AdapterError('provider_error', `Maps failed: ${failures.join(', ')}`),
      { reason: `maps:${failures.map(failure => failure.split(' ')[0]).join(',')}` },
    ))
  }).pipe(Effect.timeoutOrElse({
    duration: PAGE_TIMEOUT_MS,
    orElse: () => Effect.fail(new AdapterError('timeout', 'Maps page request timed out')),
  }))
}

function toHit(place: Place, rank: number): Hit {
  const url = place.website ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.placeId}`
  return {
    provider: 'maps',
    rank,
    url: canonicalizeUrl(url),
    title: place.name,
    snippet: [place.address, place.category, place.phone].filter(Boolean).join(' · '),
    mediaType: 'web',
    raw: place,
  }
}

export const maps: ProviderAdapter = {
  name: 'maps',
  timeoutMs: 120_000,
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: PAGE_SIZE,
    pages: true,
  },
  costModel: { kind: 'free' },
  search(query, ctx) {
    return Effect.gen(function* () {
      const seen = new Set<string>()
      for (let page = 0; page < (query.googlePages ?? 1) && seen.size < query.max; page++) {
        const places = yield* ctx.request({
          requestId: `page:${page + 1}`,
          estimateMicroUSD: 0,
          retryable: false,
          run: Effect.map(Effect.result(searchPage(query.q, page * PAGE_SIZE)), result => ({ result })),
        })
        const added: Hit[] = []
        for (const place of places) {
          if (seen.has(place.placeId) || seen.size >= query.max) continue
          seen.add(place.placeId)
          added.push(toHit(place, seen.size))
        }
        yield* ctx.addHits(added)
        if (!added.length || places.length < PAGE_SIZE) break
      }
    })
  },
}
