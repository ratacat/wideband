import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import type { Browser, CDPSession, Page } from 'patchright'
import { browserFailures, proxyUrls, recordTry, SearchError, solveSorry, sorryForm, stickyProxy } from '../google-search.mjs'
import { BROWSER_PORT, BrowserRequest, type BrowserReply } from './client'
import { openRelay, type Relay } from './relay'
import { parseSerp, type SerpResult } from './serp'

const MAX_SESSIONS = 2
const PACE_MS = 12_000
const OPEN_SPACING_MS = 5_000
const FAILED_TRIES_PER_HOUR = 40
const MISS_STREAK_LIMIT = 2
const IDLE_MS = 1_800_000
const NAVIGATION_MS = 20_000
const LAYOUTS = {
  desktop: { userAgent: (version: string) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`, platform: 'MacIntel', viewport: { width: 1280, height: 900 } },
  mobile: { userAgent: () => 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', platform: 'Linux armv81', viewport: { width: 412, height: 915 } },
}
const CONSENT = [
  { name: 'SOCS', value: 'CAESHAgBEhJnd3NfMjAyNjA5MjktMF9SQzEaAmVuIAEaBgiA_PvHBg', domain: '.google.com', path: '/' },
  { name: 'CONSENT', value: 'PENDING+987', domain: '.google.com', path: '/' },
]
const BLOCKED_URLS = ['*.png*', '*.jpg*', '*.jpeg*', '*.gif*', '*.webp*', '*.svg*', '*.ico*', '*.woff*', '*.ttf*', '*.mp4*', '*.webm*', '*/images/*', '*encrypted-tbn*', '*googleusercontent.com*', '*fonts.gstatic.com*', '*/gen_204*', '*/client_204*', '*/log?*', '*play.google.com*', '*googleadservices*', '*doubleclick*', '*ogs.google.com*', '*/async/*', '*apis.google.com*', '*/maps/vt*', '*maps.googleapis*', '*/recaptcha/*', '*/xjs/*', '*/_/js/*', '*/og/_/*', '*/_/ss/*', '*/_/scs/*']

type SessionState = 'starting' | 'warm' | 'blocked' | 'retired'
type Verdict = 'ok' | 'captcha' | 'forbidden' | 'enablejs' | 'unrecognized' | 'transport' | 'timeout' | 'crash'
const NEXT: Record<SessionState, Record<Verdict, SessionState>> = {
  starting: { ok: 'warm', captcha: 'blocked', forbidden: 'blocked', enablejs: 'blocked', unrecognized: 'retired', transport: 'starting', timeout: 'blocked', crash: 'retired' },
  warm: { ok: 'warm', captcha: 'blocked', forbidden: 'blocked', enablejs: 'blocked', unrecognized: 'warm', transport: 'warm', timeout: 'blocked', crash: 'retired' },
  blocked: { ok: 'blocked', captcha: 'blocked', forbidden: 'blocked', enablejs: 'blocked', unrecognized: 'blocked', transport: 'blocked', timeout: 'blocked', crash: 'blocked' },
  retired: { ok: 'retired', captcha: 'retired', forbidden: 'retired', enablejs: 'retired', unrecognized: 'retired', transport: 'retired', timeout: 'retired', crash: 'retired' },
}

type Session = { slot: number; state: SessionState; busy: boolean; nextAt: number; queries: number; missStreak: number; proxy: URL; relay: Relay; browser: Browser; page: Page; cdp: CDPSession }
type Ask = { q: string; start: number; deadlineAt: number; solve: boolean; microUSD: number }
type Pool = { sessions: Session[]; opening: number; nextOpenAt: number; waiters: Set<() => void>; lastRequestAt: number }
type Served = { verdict: Verdict; page: { results: (SerpResult & { rank: number })[]; nextStart: number | null } | null }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

async function openSession(pool: Pool): Promise<Session> {
  const proxies = proxyUrls()
  const taken = new Set(pool.sessions.map(session => session.slot))
  let slot = 10_000 + Math.floor(Math.random() * 40_000)
  while (taken.has(slot)) slot = 10_000 + Math.floor(Math.random() * 40_000)
  const proxy = new URL(stickyProxy(proxies[slot % proxies.length]!, slot))
  const relay = await openRelay(proxy)
  let browser: Browser | undefined
  try {
    const { chromium } = await import('patchright')
    browser = await chromium.launch({ channel: 'chrome', headless: true, proxy: { server: relay.url } })
    const context = await browser.newContext({ userAgent: LAYOUTS.desktop.userAgent(browser.version()), viewport: LAYOUTS.desktop.viewport, locale: 'en-US', timezoneId: 'America/Denver' })
    await context.addCookies(CONSENT)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS })
    const session: Session = { slot, state: 'starting', busy: true, nextAt: 0, queries: 0, missStreak: 0, proxy, relay, browser, page, cdp }
    browser.on('disconnected', () => void retire(pool, session, 'crash'))
    log(`session ${slot} starting on chrome ${browser.version()}`)
    return session
  } catch (error) {
    await browser?.close().catch(() => {})
    await relay.close()
    throw error
  }
}

async function retire(pool: Pool, session: Session, verdict: Verdict) {
  if (!pool.sessions.includes(session)) return
  pool.sessions = pool.sessions.filter(other => other !== session)
  log(`session ${session.slot} ${session.state} after ${session.queries} queries (${verdict})`)
  await Promise.race([session.browser.close().catch(() => {}), sleep(5_000)])
  await session.relay.close()
  wake(pool)
}

function wake(pool: Pool) {
  for (const waiter of pool.waiters) waiter()
  pool.waiters.clear()
}

async function capped(): Promise<boolean> {
  return await browserFailures(3_600_000) >= FAILED_TRIES_PER_HOUR
}

async function acquire(pool: Pool, deadlineAt: number): Promise<Session | 'busy' | 'capped'> {
  const waitingSince = Date.now()
  for (;;) {
    const free = pool.sessions.filter(session => !session.busy && session.nextAt < deadlineAt).sort((a, b) => a.nextAt - b.nextAt)[0]
    if (free) {
      free.busy = true
      await sleep(free.nextAt - Date.now())
      return free
    }
    const demand = !pool.sessions.some(session => session.state === 'warm') || Date.now() - waitingSince >= PACE_MS
    if (demand && !pool.opening && pool.sessions.length < MAX_SESSIONS && pool.nextOpenAt < deadlineAt) {
      if (await capped()) {
        if (!pool.sessions.length && !pool.opening) return 'capped'
      } else {
        pool.opening++
        const wait = pool.nextOpenAt - Date.now()
        pool.nextOpenAt = Math.max(Date.now(), pool.nextOpenAt) + OPEN_SPACING_MS
        try {
          await sleep(wait)
          const session = await openSession(pool)
          pool.sessions.push(session)
          return session
        } catch (error) {
          log(`session open failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`)
          return 'busy'
        } finally {
          pool.opening--
        }
      }
    }
    if (Date.now() >= deadlineAt) return 'busy'
    await new Promise<void>(resolve => {
      pool.waiters.add(resolve)
      setTimeout(resolve, Math.min(deadlineAt - Date.now(), Math.max(1_000, pool.nextOpenAt - Date.now()), PACE_MS))
    })
  }
}

async function useMobileLayout(session: Session) {
  await session.cdp.send('Network.setUserAgentOverride', { userAgent: LAYOUTS.mobile.userAgent(), platform: LAYOUTS.mobile.platform })
  await session.page.setViewportSize(LAYOUTS.mobile.viewport)
}

function failure(session: Session, error: unknown): Verdict {
  if (session.page.isClosed()) return 'crash'
  const message = error instanceof Error ? error.message : ''
  return /net::ERR_(TUNNEL|PROXY|CONNECTION|EMPTY_RESPONSE|SOCKET)/.test(message) ? 'transport' : 'timeout'
}

async function solveCaptcha(session: Session, ask: Ask, html: string, layout: string): Promise<string> {
  ask.solve = false
  const startedAt = Date.now()
  let outcome = 'solved'
  try {
    const form = sorryForm(html)
    if (!form) throw new SearchError('solve', 'The captcha page has no form.', ['solve:form'])
    const cookies = Object.fromEntries((await session.page.context().cookies('https://www.google.com')).map(cookie => [cookie.name, cookie.value]))
    const solution = await Effect.runPromise(solveSorry({ pageUrl: session.page.url(), form, proxy: session.proxy.href, cookies }))
    ask.microUSD += solution.microUSD
    await session.page.locator('#captcha-form').evaluate((captcha, token) => {
      const field = captcha.querySelector('[name="g-recaptcha-response"]') ?? captcha.appendChild(Object.assign(captcha.ownerDocument.createElement('textarea'), { name: 'g-recaptcha-response' }))
      field.value = token
      captcha.submit()
    }, solution.token)
    await session.page.waitForURL(url => !url.pathname.startsWith('/sorry/'), { timeout: NAVIGATION_MS, waitUntil: 'domcontentloaded' })
  } catch (error) {
    outcome = error instanceof SearchError ? error.failures[0] ?? 'solve:error' : 'solve:navigation'
  }
  ask.deadlineAt += Date.now() - startedAt
  log(`session ${session.slot} ${outcome} in ${Date.now() - startedAt}ms`)
  await recordTry({ route: 'browser', query: ask.q, attempt: session.queries + 1, outcome, ip: null, bytes: null, proxy: session.proxy.host, family: layout, agent: null, slot: session.slot }).catch(() => {})
  return session.page.content()
}

async function search(pool: Pool, session: Session, ask: Ask): Promise<Served> {
  const before = session.relay.bytes()
  const startedAt = Date.now()
  const layout = session.state === 'starting' ? 'desktop' : 'mobile'
  const { q: query, start } = ask
  const url = `https://www.google.com/search?${new URLSearchParams({ q: query, hl: 'en', gl: 'us', ...(start ? { start: String(start) } : {}) })}`
  let served: Served
  try {
    const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_MS })
    let html = await session.page.content()
    let serp = response?.status() === 403 ? { verdict: 'forbidden' as const } : parseSerp(html, session.page.url(), start)
    if (serp.verdict === 'captcha' && ask.solve) {
      html = await solveCaptcha(session, ask, html, layout)
      serp = parseSerp(html, session.page.url(), start)
    }
    served = serp.verdict === 'ok'
      ? { verdict: 'ok', page: { results: serp.results.map((result, index) => ({ rank: start + index + 1, ...result })), nextStart: serp.nextStart } }
      : { verdict: serp.verdict === 'desktop' ? (layout === 'desktop' ? 'ok' : 'unrecognized') : serp.verdict, page: null }
    if (served.verdict === 'unrecognized') writeFileSync(join(homedir(), '.wideband', `browser-unrecognized-${layout}.html`), html)
  } catch (error) {
    served = { verdict: failure(session, error), page: null }
  }
  session.queries++
  session.nextAt = Date.now() + PACE_MS
  session.missStreak = served.verdict === 'transport' || served.verdict === 'unrecognized' ? session.missStreak + 1 : 0
  const previous = session.state
  session.state = session.missStreak >= MISS_STREAK_LIMIT ? 'retired' : NEXT[session.state][served.verdict]
  log(`session ${session.slot} query ${session.queries} ${layout} ${served.verdict} ${Date.now() - startedAt}ms ${Math.round((session.relay.bytes() - before) / 1024)}KB`)
  await recordTry({ route: 'browser', query, attempt: session.queries, outcome: served.verdict, ip: null, bytes: session.relay.bytes() - before, proxy: session.proxy.host, family: layout, agent: null, slot: session.slot }).catch(() => {})
  if (previous === 'starting' && session.state === 'warm') {
    log(`session ${session.slot} warm`)
    await useMobileLayout(session).catch(() => { session.state = 'retired' })
  }
  if (session.state === 'blocked' || session.state === 'retired') await retire(pool, session, served.verdict)
  else {
    session.busy = false
    wake(pool)
  }
  return served
}

async function answer(pool: Pool, request: BrowserRequest, gone: () => boolean): Promise<BrowserReply> {
  const ask: Ask = { ...request, microUSD: 0 }
  while (Date.now() < ask.deadlineAt && !gone()) {
    const session = await acquire(pool, ask.deadlineAt)
    if (session === 'busy' || session === 'capped') return { ok: false, code: session, microUSD: ask.microUSD }
    const served = await search(pool, session, ask)
    if (served.page) return { ok: true, ...served.page, microUSD: ask.microUSD }
    if (served.verdict === 'unrecognized') return { ok: false, code: 'unrecognized', microUSD: ask.microUSD }
  }
  return { ok: false, code: 'timeout', microUSD: ask.microUSD }
}

function status(pool: Pool) {
  return {
    sessions: pool.sessions.map(({ slot, state, busy, queries, relay }) => ({ slot, state, busy, queries, bytes: relay.bytes() })),
    opening: pool.opening,
    idleMs: Date.now() - pool.lastRequestAt,
  }
}

async function handle(pool: Pool, request: IncomingMessage, response: ServerResponse) {
  const reply = (code: number, body: unknown) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (request.headers.host !== `127.0.0.1:${BROWSER_PORT}`) return reply(403, { error: 'host' })
  if (request.method === 'GET' && request.url === '/status') return reply(200, status(pool))
  if (request.method !== 'POST' || request.url !== '/search' || !request.headers['content-type']?.startsWith('application/json')) return reply(404, { error: 'route' })
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 10_000) return reply(413, { error: 'size' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return reply(400, { error: 'json' })
  }
  const decoded = Schema.decodeUnknownOption(BrowserRequest)(parsed)
  if (decoded._tag === 'None') return reply(400, { error: 'request' })
  pool.lastRequestAt = Date.now()
  let closed = false
  response.on('close', () => { closed = true })
  reply(200, await answer(pool, decoded.value, () => closed))
  pool.lastRequestAt = Date.now()
}

export async function serve(): Promise<void> {
  mkdirSync(join(homedir(), '.wideband'), { recursive: true })
  const pool: Pool = { sessions: [], opening: 0, nextOpenAt: 0, waiters: new Set(), lastRequestAt: Date.now() }
  const server = createServer((request, response) => void handle(pool, request, response))
  const bound = await new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false))
    server.listen(BROWSER_PORT, '127.0.0.1', () => resolve(true))
  })
  if (!bound) return log(`port ${BROWSER_PORT} is taken; another browser pool is serving`)
  log(`browser pool listening on 127.0.0.1:${BROWSER_PORT}`)
  await new Promise<void>(resolve => {
    const stop = () => {
      clearInterval(timer)
      server.close()
      void Promise.all(pool.sessions.map(session => retire(pool, session, 'crash'))).then(() => resolve())
    }
    const timer = setInterval(() => {
      if (Date.now() - pool.lastRequestAt > IDLE_MS && !pool.sessions.some(session => session.busy)) stop()
    }, 60_000)
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
  log('browser pool stopped')
}
