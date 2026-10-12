import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Effect, Option, Result, Schema } from 'effect'
import { SearchError, searchEffect, tryCounts } from './google-search.mjs'
import type { GooglePage } from './google-search.mjs'

export const BROWSER_PORT = 47651
const BROWSER_QUEUE_MS = 30_000
const BROWSER_REPLY_MS = 60_000
const STARTUP_POLLS = 30
const HEALTH_WINDOW_MS = 600_000
const HEALTH_MIN_TRIES = 20
const UNHEALTHY_BELOW = 0.2

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const BrowserRequest = Schema.Struct({ q: Schema.String.check(Schema.isMinLength(1)), start: Count, deadlineAt: Schema.Finite })
export type BrowserRequest = typeof BrowserRequest.Type
export const BrowserReply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    results: Schema.Array(Schema.Struct({ rank: Count, title: Schema.String, url: Schema.String, snippet: Schema.String })),
    nextStart: Schema.NullOr(Count),
  }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.Literals(['busy', 'capped', 'timeout', 'unrecognized', 'unavailable']) }),
])
export type BrowserReply = typeof BrowserReply.Type

const RouteMode = Schema.Literals(['auto', 'http', 'browser'])
type RouteMode = typeof RouteMode.Type
type Route = 'http' | 'browser'
type HealthWindow = { httpTries: number; httpPassed: number }

export function routeOrder(mode: RouteMode, window: HealthWindow): readonly Route[] {
  if (mode !== 'auto') return [mode]
  const unhealthy = window.httpTries >= HEALTH_MIN_TRIES && window.httpPassed < window.httpTries * UNHEALTHY_BELOW
  return unhealthy ? ['browser', 'http'] : ['http', 'browser']
}

function post(body: string, signal: AbortSignal): Promise<Response | undefined> {
  return fetch(`http://127.0.0.1:${BROWSER_PORT}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }).catch(() => undefined)
}

function startDaemon() {
  const directory = join(homedir(), '.wideband')
  mkdirSync(directory, { recursive: true })
  const log = openSync(join(directory, 'browser.log'), 'a')
  spawn(process.execPath, [Bun.which('wideband') ?? process.argv[1] ?? 'wideband', 'browser'], { detached: true, stdio: ['ignore', log, log] }).unref()
}

async function askDaemon(query: string, start: number, signal: AbortSignal): Promise<BrowserReply> {
  const body = JSON.stringify({ q: query, start, deadlineAt: Date.now() + BROWSER_QUEUE_MS })
  let response = await post(body, signal)
  if (!response) startDaemon()
  for (let poll = 0; !response && poll < STARTUP_POLLS && !signal.aborted; poll++) {
    await Bun.sleep(100)
    response = await post(body, signal)
  }
  return response ? Schema.decodeUnknownSync(BrowserReply)(await response.json()) : { ok: false, code: 'unavailable' }
}

export function browserPage(query: string, start: number): Effect.Effect<GooglePage, SearchError> {
  return Effect.tryPromise({
    try: signal => askDaemon(query, start, AbortSignal.any([signal, AbortSignal.timeout(BROWSER_REPLY_MS)])),
    catch: () => new SearchError('browser', 'The browser route returned no usable reply.', ['browser:unavailable']),
  }).pipe(Effect.flatMap(reply => reply.ok
    ? Effect.succeed({ query, start, results: [...reply.results], nextStart: reply.nextStart })
    : Effect.fail(new SearchError('browser', `The browser route answered ${reply.code}.`, [`browser:${reply.code}`]))))
}

export function googlePage(query: string, start: number): Effect.Effect<GooglePage, SearchError | TypeError> {
  return Effect.gen(function* () {
    const mode = Option.getOrElse(Schema.decodeUnknownOption(RouteMode)(process.env.WIDEBAND_GOOGLE_ROUTE), (): RouteMode => 'auto')
    const window = mode === 'auto'
      ? yield* Effect.tryPromise(() => tryCounts(HEALTH_WINDOW_MS)).pipe(Effect.orElseSucceed(() => ({ httpTries: 0, httpPassed: 0 })))
      : { httpTries: 0, httpPassed: 0 }
    const failures: string[] = []
    for (const route of routeOrder(mode, window)) {
      const attempt = yield* Effect.result(route === 'http' ? searchEffect(query, start) : browserPage(query, start))
      if (Result.isSuccess(attempt)) return attempt.success
      if (!(attempt.failure instanceof SearchError)) return yield* Effect.fail(attempt.failure)
      failures.push(...(attempt.failure.failures.length ? attempt.failure.failures : [attempt.failure.code]))
    }
    return yield* Effect.fail(new SearchError('exhausted', `Every Google route failed: ${failures.join(', ')}.`, failures))
  })
}
