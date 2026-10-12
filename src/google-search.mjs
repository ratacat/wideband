import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { Effect, Schema } from 'effect';
import families from './google-agents.json' with { type: 'json' };

const PYTHON = `import json, sys
from curl_cffi import requests
data = json.load(sys.stdin)
try:
    response = requests.request(
        data["method"], data["url"], params=data.get("params"), data=data.get("form"),
        headers=data["headers"], cookies=data["cookies"], default_headers=False, http_version="v1",
        proxy=data["proxy"], impersonate="chrome99_android", timeout=20, allow_redirects=False,
    )
    print(json.dumps({"status": response.status_code, "location": response.headers.get("location", ""), "html": response.text, "bytes": response.request_size + response.header_size + response.download_size, "cookies": {cookie.name: cookie.value for cookie in response.cookies.jar}}))
except requests.exceptions.RequestException:
    print(json.dumps({"error": "transport"}))
`;

const ATTEMPTS = 5;
const PAGE_TIMEOUT_MS = 75_000;
const TRY_HISTORY_MS = 604_800_000;
const PACE_MS = 12_000;
const LEASE_MS = 30_000;
const SLOT_IDLE_MS = 1_800_000;
const FIRST_HTTP_SLOT = 50_000;
const HTTP_SLOTS = 50_000;
const SEARCH_URL = 'https://www.google.com/search';
const SORRY_URL = 'https://www.google.com/sorry/index';
const SOLVER_URL = 'https://api.2captcha.com';
const SOLVE_POLL_MS = 5_000;
const SOLVE_FROM_TRY = 2;
export const SOLVE_TIMEOUT_MS = 120_000;
const FAMILIES = new Map(families.map(({ family, headers }) => [family, headers]));
const AGENTS = families.flatMap(({ family, agents }) => agents.map(agent => ({ family, agent })));

const Response = Schema.Union([
  Schema.Struct({ status: Schema.Finite.check(Schema.isInt()), location: Schema.String, html: Schema.String, bytes: Schema.Finite.check(Schema.isInt()), cookies: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ error: Schema.Literal('transport') }),
]);
const decodeResponse = Schema.decodeUnknownSync(Response);
const SolverFailure = Schema.Struct({ errorId: Schema.Finite.check(Schema.isGreaterThan(0)), errorCode: Schema.String });
const decodeCreated = Schema.decodeUnknownSync(Schema.Union([Schema.Struct({ errorId: Schema.Literal(0), taskId: Schema.Finite }), SolverFailure]));
const decodeTaskResult = Schema.decodeUnknownSync(Schema.Union([
  Schema.Struct({ errorId: Schema.Literal(0), status: Schema.Literal('processing') }),
  Schema.Struct({ errorId: Schema.Literal(0), status: Schema.Literal('ready'), cost: Schema.String, solution: Schema.Struct({ gRecaptchaResponse: Schema.String }) }),
  SolverFailure,
]));

export class SearchError extends Error {
  constructor(code, message, failures = [], microUSD = 0) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.failures = failures;
    this.microUSD = microUSD;
  }
}

const clean = value => value.replace(/\s+/g, ' ').trim();

function destination(href) {
  try {
    const link = new URL(href, 'https://www.google.com');
    const target = link.hostname === 'www.google.com' && link.pathname === '/url'
      ? new URL(link.searchParams.get('q') || link.searchParams.get('url'))
      : link;
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    if (target.hostname === 'google.com' || target.hostname.endsWith('.google.com')) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function parseResults(html, start = 0) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string.');
  if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('Start must be a nonnegative integer.');
  const $ = load(html);
  const text = clean($('body').text());
  if ($('form[action*="/sorry"], #captcha-form, .g-recaptcha').length || /unusual traffic from your computer network/i.test(text)) {
    throw new SearchError('blocked', 'Google returned a CAPTCHA or traffic block.');
  }
  if ($('form[action*="consent.google"]').length || /Before you continue to Google/i.test(text)) {
    throw new SearchError('consent', 'Google returned a consent page.');
  }
  const results = [];
  const seen = new Set();
  for (const card of $('.zMzFAb').toArray()) {
    const anchor = $(card).find('a.fuLhoc').first();
    const title = clean(anchor.find('.CVA68e').first().text());
    const url = destination(anchor.attr('href'));
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const snippet = clean($(card).find('.taTFJ .FrIlee').toArray().map(node => $(node).text()).join(' '));
    results.push({ rank: start + results.length + 1, title, url, snippet });
  }
  let nextStart = null;
  for (const anchor of $('a[href]').toArray()) {
    const href = $(anchor).attr('href');
    if (!URL.canParse(href, 'https://www.google.com')) continue;
    const link = new URL(href, 'https://www.google.com');
    if (link.hostname !== 'www.google.com' || link.pathname !== '/search') continue;
    const next = Number(link.searchParams.get('start'));
    if (Number.isSafeInteger(next) && next > start && (nextStart === null || next < nextStart)) nextStart = next;
  }
  if (!results.length) {
    if (/did not match any documents|No results found for/i.test(text)) return { results, nextStart: null };
    if (/enable javascript|not redirected within a few seconds|trouble accessing Google Search/i.test(text)) {
      throw new SearchError('challenge', 'Google returned a JavaScript challenge.');
    }
    if (/browser isn't supported anymore/i.test(text)) throw new SearchError('unsupported', 'Google does not serve this User-Agent.');
    throw new SearchError('unrecognized', 'No organic results or explicit no-results message found.');
  }
  return { results, nextStart };
}

export function sorryForm(html) {
  const $ = load(html);
  const form = $('#captcha-form');
  const widget = $('.g-recaptcha').first();
  const fields = {
    sitekey: widget.attr('data-sitekey'),
    dataS: widget.attr('data-s'),
    q: form.find('input[name="q"]').attr('value'),
    continue: form.find('input[name="continue"]').attr('value'),
  };
  return Object.values(fields).every(Boolean) ? fields : null;
}

function transport(input) {
  return Effect.callback((resume, signal) => {
    const child = spawn('uv', ['run', '--quiet', '--with', 'curl-cffi==0.16.3', 'python', '-c', PYTHON], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let closed;
    const done = new Promise(resolve => { closed = resolve; });
    const kill = () => {
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.length > 5_000_000) kill();
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      closed();
      if (spawnFailed) return resume(Effect.fail(new SearchError('runtime', 'Could not start uv. Install uv and Python 3.10 or newer.')));
      if (code !== 0) return resume(Effect.fail(new SearchError('runtime', 'The Python transport failed. Check uv and curl_cffi installation.')));
      resume(Effect.try({
        try: () => decodeResponse(JSON.parse(output)),
        catch: () => new SearchError('invalid_response', 'The Python transport returned invalid output.'),
      }));
    });
    child.stdin.end(JSON.stringify(input));
    return Effect.promise(() => { kill(); return done; });
  });
}

const solveFailure = (code, message) => new SearchError('solve', message, [`solve:${code}`]);

function askSolver(method, body, decode) {
  return Effect.tryPromise({
    try: signal => fetch(`${SOLVER_URL}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: process.env.WIDEBAND_2CAPTCHA_KEY, ...body }), signal }).then(response => response.json()),
    catch: () => solveFailure('transport', 'The captcha solver could not be reached.'),
  }).pipe(
    Effect.flatMap(json => Effect.try({ try: () => decode(json), catch: () => solveFailure('invalid_response', 'The captcha solver returned invalid output.') })),
    Effect.flatMap(reply => reply.errorId ? Effect.fail(solveFailure(reply.errorCode, `The captcha solver answered ${reply.errorCode}.`)) : Effect.succeed(reply)),
  );
}

export function solveSorry({ pageUrl, form, proxy, cookies }) {
  const exit = new URL(proxy);
  const task = {
    type: 'RecaptchaV2EnterpriseTask',
    websiteURL: pageUrl,
    websiteKey: form.sitekey,
    enterprisePayload: { s: form.dataS },
    cookies: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; '),
    proxyType: exit.protocol.slice(0, -1),
    proxyAddress: exit.hostname,
    proxyPort: Number(exit.port || 80),
    proxyLogin: decodeURIComponent(exit.username),
    proxyPassword: decodeURIComponent(exit.password),
  };
  return Effect.gen(function* () {
    const { taskId } = yield* askSolver('createTask', { task }, decodeCreated);
    for (;;) {
      yield* Effect.sleep(SOLVE_POLL_MS);
      const result = yield* askSolver('getTaskResult', { taskId }, decodeTaskResult);
      if (result.status === 'ready') return { token: result.solution.gRecaptchaResponse, microUSD: Math.round(Number(result.cost) * 1e6) };
    }
  }).pipe(Effect.timeoutOrElse({
    duration: SOLVE_TIMEOUT_MS,
    orElse: () => Effect.fail(solveFailure('timeout', 'The captcha solver did not answer in time.')),
  }));
}

function proxyUrl(host, port, username, password, protocol = 'http') {
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

function proxyFromLine(line, number) {
  if (line.includes('://')) return line;
  const at = line.lastIndexOf('@');
  const [host, port, ...rest] = line.slice(at + 1).split(':');
  if (!host || !/^\d+$/.test(port ?? '')) throw new SearchError('inventory', `WIDEBAND_PROXY_FILE line ${number} is not host:port, host:port:user:pass, user:pass@host:port or a URL.`);
  const credentials = at > 0 ? line.slice(0, at) : rest.join(':');
  const split = credentials.indexOf(':');
  return split < 0 ? proxyUrl(host, port, credentials) : proxyUrl(host, port, credentials.slice(0, split), credentials.slice(split + 1));
}

export function proxyUrls() {
  const file = process.env.WIDEBAND_PROXY_FILE;
  if (!file) throw new SearchError('inventory', 'Set WIDEBAND_PROXY_FILE to a file with one proxy per line.');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new SearchError('inventory', `Cannot read WIDEBAND_PROXY_FILE ${file}.`); }
  if (text.trimStart().startsWith('[')) {
    let records;
    try { records = JSON.parse(text); }
    catch { throw new SearchError('inventory', 'WIDEBAND_PROXY_FILE is not a valid JSON array.'); }
    return records.map((record, index) => {
      if (!record?.host || !/^\d+$/.test(String(record.port))) throw new SearchError('inventory', `WIDEBAND_PROXY_FILE record ${index + 1} needs a host and a port.`);
      return proxyUrl(record.host, record.port, record.username, record.password, record.protocol);
    });
  }
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const line = raw.trim();
    return line && !line.startsWith('#') ? [proxyFromLine(line, index + 1)] : [];
  });
}

function exitIp(location = '') {
  const token = URL.canParse(location) ? new URL(location).searchParams.get('q') : null;
  const bytes = Buffer.from(token ?? '', 'base64url');
  return bytes[0] === 0x12 && bytes[1] === 4 ? bytes.subarray(2, 6).join('.') : null;
}

export function stickyProxy(proxy, slot) {
  return proxy.replace(/^([^:/]+:\/\/[^:@/]*)-rotate(?=(?::[^@/]*)?@)/, `$1-${slot}`);
}

async function withStore(run) {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(homedir(), '.wideband');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'google-tries.sqlite'));
  try {
    db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS tries (at INTEGER NOT NULL, query TEXT NOT NULL, attempt INTEGER NOT NULL, outcome TEXT NOT NULL, ip TEXT, bytes INTEGER, proxy TEXT NOT NULL, family TEXT, agent TEXT, route TEXT NOT NULL DEFAULT 'http', slot INTEGER); CREATE INDEX IF NOT EXISTS tries_at ON tries (at); CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY, family TEXT NOT NULL, agent TEXT NOT NULL, cookies TEXT NOT NULL, next_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, queries INTEGER NOT NULL, used_at INTEGER NOT NULL)");
    const columns = new Set(db.prepare('PRAGMA table_info(tries)').all().map(column => column.name));
    if (!columns.has('route')) db.exec("ALTER TABLE tries ADD COLUMN route TEXT NOT NULL DEFAULT 'http'");
    if (!columns.has('slot')) db.exec('ALTER TABLE tries ADD COLUMN slot INTEGER');
    return run(db);
  } finally { db.close(); }
}

export function recordTry(row) {
  return withStore(db => {
    db.prepare('INSERT INTO tries (at, route, query, attempt, outcome, ip, bytes, proxy, family, agent, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(Date.now(), row.route, row.query, row.attempt, row.outcome, row.ip, row.bytes, row.proxy, row.family, row.agent, row.slot);
    db.prepare('DELETE FROM tries WHERE at < ?').run(Date.now() - TRY_HISTORY_MS);
  });
}

export function browserFailures(sinceMs) {
  return withStore(db => Number(db.prepare("SELECT count(*) AS failed FROM tries WHERE route = 'browser' AND outcome != 'ok' AND at >= ?").get(Date.now() - sinceMs).failed)).catch(() => 0);
}

function freshSlot(taken) {
  let slot;
  do slot = FIRST_HTTP_SLOT + Math.floor(Math.random() * HTTP_SLOTS); while (taken.has(slot));
  const { family, agent } = AGENTS[Math.floor(Math.random() * AGENTS.length)];
  return { slot, family, agent, cookies: {}, queries: 0 };
}

function lease(now) {
  return withStore(db => {
    db.prepare('DELETE FROM slots WHERE used_at < ?').run(now - SLOT_IDLE_MS);
    const warm = db.prepare('UPDATE slots SET lease_until = ? WHERE slot = (SELECT slot FROM slots WHERE lease_until <= ? AND next_at <= ? ORDER BY next_at LIMIT 1) RETURNING slot, family, agent, cookies, queries').get(now + LEASE_MS, now, now);
    if (warm) return { ...warm, cookies: JSON.parse(warm.cookies) };
    return freshSlot(new Set(db.prepare('SELECT slot FROM slots').all().map(row => row.slot)));
  });
}

function keep(slot, cookies, now) {
  return withStore(db => db.prepare('INSERT INTO slots (slot, family, agent, cookies, next_at, lease_until, queries, used_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (slot) DO UPDATE SET cookies = excluded.cookies, next_at = excluded.next_at, lease_until = 0, queries = excluded.queries, used_at = excluded.used_at').run(slot.slot, slot.family, slot.agent, JSON.stringify(cookies), now + PACE_MS, slot.queries + 1, now));
}

function drop(slot) {
  return withStore(db => db.prepare('DELETE FROM slots WHERE slot = ?').run(slot.slot));
}

function clearSorry(blocked, slot, proxy, headers) {
  return Effect.suspend(() => {
    let cookies = { ...slot.cookies, ...blocked.cookies };
    let microUSD = 0;
    const send = input => transport({ ...input, headers, cookies, proxy }).pipe(Effect.flatMap(response => {
      if ('error' in response) return Effect.fail(solveFailure('transport', 'Proxy connection failed during the solve.'));
      cookies = { ...cookies, ...response.cookies };
      return Effect.succeed(response);
    }));
    return Effect.gen(function* () {
      const redirected = blocked.location.includes('/sorry');
      const sorry = redirected ? yield* send({ method: 'GET', url: blocked.location }) : blocked;
      const form = sorryForm(sorry.html);
      if (!form) return yield* Effect.fail(solveFailure('form', 'The block page has no captcha form.'));
      const solution = yield* solveSorry({ pageUrl: redirected ? blocked.location : SORRY_URL, form, proxy, cookies });
      microUSD = solution.microUSD;
      const posted = yield* send({ method: 'POST', url: SORRY_URL, form: { 'g-recaptcha-response': solution.token, q: form.q, continue: form.continue } });
      if (!posted.location) return yield* Effect.fail(solveFailure('rejected', `Google answered the captcha token with HTTP ${posted.status}.`));
      yield* send({ method: 'GET', url: posted.location });
      return { cookies, microUSD };
    }).pipe(Effect.mapError(error => new SearchError('solve', error.message, error.code === 'solve' ? error.failures : [`solve:${error.code}`], microUSD)));
  });
}

export function createSearchEffect() {
  return function searchEffect(query, start = 0) {
    return Effect.suspend(() => {
      const failures = [];
      let microUSD = 0;
      return Effect.gen(function* () {
        const proxies = yield* Effect.try({
          try: () => {
            if (typeof query !== 'string' || !query.trim()) throw new TypeError('Query must be a nonempty string.');
            if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('Start must be a nonnegative integer.');
            const proxies = proxyUrls();
            if (!proxies.length) throw new SearchError('inventory', 'Proxy inventory is empty.');
            return proxies;
          },
          catch: error => error,
        });
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
          const slot = yield* Effect.tryPromise(() => lease(Date.now())).pipe(Effect.orElseSucceed(() => freshSlot(new Set())));
          const proxy = stickyProxy(proxies[slot.slot % proxies.length], slot.slot);
          const headers = { ...FAMILIES.get(slot.family), 'User-Agent': slot.agent };
          const record = (outcome, page = {}) => {
            if (outcome !== 'ok') failures.push(outcome);
            return Effect.tryPromise(() => recordTry({ route: 'http', query, attempt, outcome, ip: exitIp(page.location), bytes: page.bytes ?? null, proxy: new URL(proxy).host, family: slot.family, agent: slot.agent, slot: slot.slot })).pipe(Effect.ignore);
          };
          const fetchSearch = Effect.gen(function* () {
            const page = yield* transport({ method: 'GET', url: SEARCH_URL, params: { q: query, start, hl: 'en', gl: 'us', pws: '0', sca_esv: '1', gbv: '1' }, headers, cookies: slot.cookies, proxy });
            const parsed = yield* Effect.result(Effect.try({
              try: () => {
                if ('error' in page) throw new SearchError('transport', 'Proxy connection failed.');
                if (page.status === 429 || page.location.includes('/sorry')) throw new SearchError('blocked', `Google blocked this exit IP with HTTP ${page.status}.`);
                if (page.status !== 200) throw new SearchError('http', `Google returned HTTP ${page.status}.`);
                return { query, start, ...parseResults(page.html, start) };
              },
              catch: error => error,
            }));
            const outcome = parsed._tag === 'Failure' ? parsed.failure.code ?? 'error' : 'ok';
            yield* record(outcome, page);
            yield* Effect.tryPromise(() => outcome === 'ok' || outcome === 'unrecognized' ? keep(slot, { ...slot.cookies, ...page.cookies }, Date.now()) : drop(slot)).pipe(Effect.ignore);
            return { page, parsed, outcome };
          });
          const { parsed, outcome } = yield* fetchSearch;
          if (parsed._tag === 'Success') return { ...parsed.success, microUSD };
          if (!(parsed.failure instanceof SearchError) || outcome === 'unrecognized') return yield* Effect.fail(parsed.failure);
        }
        return yield* Effect.fail(new SearchError('exhausted', `Every Google try failed: ${failures.join(', ')}.`, failures));
      }).pipe(
        Effect.timeoutOrElse({
          duration: PAGE_TIMEOUT_MS,
          orElse: () => Effect.fail(new SearchError('timeout', 'Google page request timed out.')),
        }),
        Effect.mapError(error => error instanceof SearchError ? new SearchError(error.code, error.message, error.failures, microUSD) : error),
      );
    });
  };
}

export function createSearch() {
  const run = createSearchEffect();
  return (query, start = 0, options = {}) => Effect.runPromise(run(query, start), { signal: options.signal });
}

export const searchEffect = createSearchEffect();
export const search = createSearch();

export function search100(query) {
  return Effect.runPromise(Effect.gen(function* () {
    const results = new Map();
    let nextStart = 0;
    let pages = 0;
    while (pages < 10 && nextStart !== null && results.size < 100) {
      const page = yield* searchEffect(query, nextStart);
      pages++;
      for (const result of page.results) {
        if (!results.has(result.url)) results.set(result.url, result);
      }
      nextStart = page.nextStart;
    }
    return { query, results: [...results.values()].slice(0, 100), pages, nextStart };
  }));
}
