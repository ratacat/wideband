import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { SearchError, SOLVE_TIMEOUT_MS } from '../google-search.mjs'
import type { GooglePage, PageOptions } from '../google-search.mjs'

export const BROWSER_PORT = 47651
const BROWSER_QUEUE_MS = 30_000
const BROWSER_REPLY_MS = 60_000
const STARTUP_POLLS = 30

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const MicroUSD = Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))
export const BrowserRequest = Schema.Struct({ q: Schema.String.check(Schema.isMinLength(1)), start: Count, deadlineAt: Schema.Finite, solve: Schema.Boolean })
export type BrowserRequest = typeof BrowserRequest.Type
export const BrowserReply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    results: Schema.Array(Schema.Struct({ rank: Count, title: Schema.String, url: Schema.String, snippet: Schema.String })),
    nextStart: Schema.NullOr(Count),
    microUSD: MicroUSD,
  }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.Literals(['busy', 'capped', 'timeout', 'unrecognized', 'unavailable']), microUSD: MicroUSD }),
])
export type BrowserReply = typeof BrowserReply.Type

function post(body: string, signal: AbortSignal): Promise<Response | undefined> {
  return fetch(`http://127.0.0.1:${BROWSER_PORT}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }).catch(() => undefined)
}

function startDaemon() {
  const directory = join(homedir(), '.wideband')
  mkdirSync(directory, { recursive: true })
  const log = openSync(join(directory, 'browser.log'), 'a')
  spawn(process.execPath, [Bun.which('wideband') ?? process.argv[1] ?? 'wideband', 'browser'], { detached: true, stdio: ['ignore', log, log] }).unref()
}

async function askDaemon(query: string, start: number, solve: boolean, signal: AbortSignal): Promise<BrowserReply> {
  const body = JSON.stringify({ q: query, start, deadlineAt: Date.now() + BROWSER_QUEUE_MS, solve })
  let response = await post(body, signal)
  if (!response) startDaemon()
  for (let poll = 0; !response && poll < STARTUP_POLLS && !signal.aborted; poll++) {
    await Bun.sleep(100)
    response = await post(body, signal)
  }
  return response ? Schema.decodeUnknownSync(BrowserReply)(await response.json()) : { ok: false, code: 'unavailable', microUSD: 0 }
}

export function browserPage(query: string, start: number, options: PageOptions = {}): Effect.Effect<GooglePage, SearchError> {
  const solve = options.solve === true
  return Effect.tryPromise({
    try: signal => askDaemon(query, start, solve, AbortSignal.any([signal, AbortSignal.timeout(BROWSER_REPLY_MS + (solve ? SOLVE_TIMEOUT_MS : 0))])),
    catch: () => new SearchError('browser', 'The browser route returned no usable reply.', ['browser:unavailable']),
  }).pipe(Effect.flatMap(reply => reply.ok
    ? Effect.succeed({ query, start, results: [...reply.results], nextStart: reply.nextStart, microUSD: reply.microUSD })
    : Effect.fail(new SearchError('browser', `The browser route answered ${reply.code}.`, [`browser:${reply.code}`], reply.microUSD))))
}
