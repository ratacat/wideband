import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { Effect, Schema } from 'effect';

const PYTHON = `import json, sys
from curl_cffi import requests
data = json.load(sys.stdin)
try:
    response = requests.get(
        "https://www.google.com/search",
        params={"q": data["query"], "start": data["start"], "hl": "en", "gl": "us", "pws": "0", "sca_esv": "1", "gbv": "1"},
        headers={"User-Agent": "NokiaN72/2.0617.1.0.3 Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1"},
        proxy=data["proxy"], impersonate="chrome99_android", timeout=20, allow_redirects=False,
    )
    print(json.dumps({"status": response.status_code, "location": response.headers.get("location", ""), "html": response.text}))
except requests.exceptions.RequestException:
    print(json.dumps({"error": "transport"}))
`;

const PROXY_SPACING_MS = 180_000;
const PROXY_WAIT_MS = 45_000;
const FAILURE_REST_MS = 900_000;
const BLOCK_REST_MS = 7_200_000;
const BLOCKS = new Set(['blocked', 'challenge']);

const Response = Schema.Union([
  Schema.Struct({ status: Schema.Finite.check(Schema.isInt()), location: Schema.String, html: Schema.String }),
  Schema.Struct({ error: Schema.Literal('transport') }),
]);
const decodeResponse = Schema.decodeUnknownSync(Response);

export class SearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
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
    throw new SearchError('unrecognized', 'No organic results or explicit no-results message found.');
  }
  return { results, nextStart };
}

function fetchPage(input) {
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

function proxyUrls() {
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

function proxyOperation(operation) {
  return Effect.tryPromise({
    try: operation,
    catch: error => error instanceof SearchError ? error : new SearchError('inventory', 'Google proxy reservations failed.'),
  });
}

export function createSearchEffect() {
  return function searchEffect(query, start = 0) {
    return Effect.gen(function* () {
      const pool = yield* Effect.try({
        try: () => {
          if (typeof query !== 'string' || !query.trim()) throw new TypeError('Query must be a nonempty string.');
          if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('Start must be a nonnegative integer.');
          const proxies = proxyUrls().map(url => ({ url, id: createHash('sha256').update(url).digest('hex') }));
          if (!proxies.length) throw new SearchError('inventory', 'Proxy inventory is empty.');
          return proxies;
        },
        catch: error => error,
      });
      const failures = [];
      const attempted = new Set();
      for (let attempt = 0; attempt < Math.min(3, pool.length); attempt++) {
        const available = pool.filter(proxy => !attempted.has(proxy.id));
        const deadline = Date.now() + PROXY_WAIT_MS;
        let lease = yield* proxyOperation(() => reserve(available));
        while (lease.id === null && lease.readyAt <= deadline) {
          yield* Effect.sleep(Math.max(0, lease.readyAt - Date.now()));
          lease = yield* proxyOperation(() => reserve(available));
        }
        if (lease.id === null) {
          if (!failures.length) return yield* Effect.fail(new SearchError('unavailable', 'No Google proxy is free; every proxy is resting or blocked.'));
          break;
        }
        const proxy = pool.find(proxy => proxy.id === lease.id);
        if (!proxy) return yield* Effect.fail(new SearchError('inventory', 'Proxy reservation does not match inventory.'));
        attempted.add(proxy.id);
        yield* Effect.sleep(Math.max(0, lease.readyAt - Date.now()));
        const page = yield* fetchPage({ query, start, proxy: proxy.url });
        const parsed = yield* Effect.result(Effect.try({
          try: () => {
            if ('error' in page) throw new SearchError('transport', 'Proxy connection failed.');
            if (page.status === 429 || page.location.includes('/sorry')) throw new SearchError('blocked', `Google blocked this proxy with HTTP ${page.status}.`);
            if (page.status !== 200) throw new SearchError('http', `Google returned HTTP ${page.status}.`);
            return { query, start, ...parseResults(page.html, start) };
          },
          catch: error => error,
        }));
        if (parsed._tag === 'Success') return parsed.success;
        const error = parsed.failure;
        if (!(error instanceof SearchError) || error.code === 'unrecognized') return yield* Effect.fail(error);
        yield* proxyOperation(async () => {
          const db = await proxyStore();
          try { db.prepare('UPDATE cooldowns SET ready_at = MAX(ready_at, ?) WHERE id = ?').run(Date.now() + (BLOCKS.has(error.code) ? BLOCK_REST_MS : FAILURE_REST_MS), proxy.id); }
          finally { db.close(); }
        });
        failures.push(error.code);
      }
      return yield* Effect.fail(new SearchError('exhausted', `Search failed after ${failures.length} proxy attempts: ${failures.join(', ')}.`));
    }).pipe(Effect.timeoutOrElse({
      duration: 45_000,
      orElse: () => Effect.fail(new SearchError('timeout', 'Google page request timed out.')),
    }));
  };
}

export function createSearch() {
  const run = createSearchEffect();
  return (query, start = 0, options = {}) => Effect.runPromise(run(query, start), { signal: options.signal });
}

async function proxyStore() {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(homedir(), '.wideband');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'google-proxies.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS cooldowns (id TEXT PRIMARY KEY, ready_at INTEGER NOT NULL)');
  return db;
}

async function reserve(pool) {
  const db = await proxyStore();
  try {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT OR IGNORE INTO cooldowns (id, ready_at) VALUES (?, 0)');
    for (const proxy of pool) insert.run(proxy.id);
    const slots = pool.map(() => '?').join(',');
    const row = db.prepare(`SELECT id, ready_at FROM cooldowns WHERE id IN (${slots}) ORDER BY ready_at, random() LIMIT 1`).get(...pool.map(proxy => proxy.id));
    if (!row) throw new SearchError('inventory', 'No proxy available.');
    const readyAt = Math.max(Date.now(), Number(row.ready_at));
    if (Number(row.ready_at) > Date.now()) {
      db.exec('COMMIT');
      return { id: null, readyAt };
    }
    db.prepare('UPDATE cooldowns SET ready_at = ? WHERE id = ?').run(readyAt + PROXY_SPACING_MS, row.id);
    db.exec('COMMIT');
    return { id: row.id, readyAt };
  } finally {
    db.close();
  }
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
