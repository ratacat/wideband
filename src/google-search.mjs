import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { load } from 'cheerio';
import { z } from 'zod';

const PYTHON = `import json, sys
from curl_cffi import requests
data = json.load(sys.stdin)
try:
    response = requests.get(
        "https://www.google.com/wml/search",
        params={"q": data["query"], "start": data["start"], "hl": "en", "gl": "us", "pws": "0", "sca_esv": "1"},
        headers={"User-Agent": "NokiaN72/2.0617.1.0.3 Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1"},
        proxy=data["proxy"], impersonate="chrome99_android", timeout=20, allow_redirects=False,
    )
    print(json.dumps({"status": response.status_code, "html": response.text}))
except requests.exceptions.RequestException:
    print(json.dumps({"error": "transport"}))
`;

const Response = z.union([
  z.object({ status: z.number().int(), html: z.string() }),
  z.object({ error: z.literal('transport') }),
]);

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
    if (link.hostname !== 'www.google.com' || !['/search', '/wml/search'].includes(link.pathname)) continue;
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

function fetchPage(input, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('uv', ['run', '--quiet', '--with', 'curl-cffi==0.16.3', 'python', '-c', PYTHON], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
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
    child.once('error', () => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(signal.reason);
      reject(new SearchError('runtime', 'Could not start uv. Install uv and Python 3.10 or newer.'));
    });
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new SearchError('runtime', 'The Python transport failed. Check uv and curl_cffi installation.'));
      try { resolve(Response.parse(JSON.parse(output))); }
      catch { reject(new SearchError('runtime', 'The Python transport returned invalid output.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createSearch(proxyType = 'residential') {
  if (!['residential', 'mobile'].includes(proxyType)) throw new TypeError('Proxy type must be residential or mobile.');
  return async function search(query, start = 0, options = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('Query must be a nonempty string.');
    if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('Start must be a nonnegative integer.');
    const deadline = AbortSignal.timeout(45_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    let pool;
    try {
      const { listProxies, proxyUrl } = await import('@ratacat/proxies');
      pool = listProxies(proxyType).map(proxy => {
        const url = proxyUrl(proxy);
        return { url, id: createHash('sha256').update(url).digest('hex') };
      });
    } catch {
      throw new SearchError('inventory', 'Install the private @ratacat/proxies package to use Google search.');
    }
    if (!pool.length) throw new SearchError('inventory', 'Proxy inventory is empty.');
    const failures = [];
    const attempted = new Set();
    for (let attempt = 0; attempt < Math.min(3, pool.length); attempt++) {
      signal.throwIfAborted();
      const available = pool.filter(proxy => !attempted.has(proxy.id));
      let lease = await reserve(available);
      while (lease.id === null) {
        await delay(Math.max(0, lease.readyAt - Date.now()), undefined, { signal });
        signal.throwIfAborted();
        lease = await reserve(available);
      }
      const proxy = pool.find(proxy => proxy.id === lease.id);
      if (!proxy) throw new SearchError('inventory', 'Proxy reservation does not match inventory.');
      attempted.add(proxy.id);
      await delay(Math.max(0, lease.readyAt - Date.now()), undefined, { signal });
      const page = await fetchPage({ query, start, proxy: proxy.url }, signal);
      try {
        if (page.error) throw new SearchError('transport', 'Proxy connection failed.');
        if (page.status !== 200) throw new SearchError('http', `Google returned HTTP ${page.status}.`);
        return { query, start, ...parseResults(page.html, start) };
      } catch (error) {
        if (!(error instanceof SearchError)) throw error;
        if (error.code === 'unrecognized') throw error;
        const db = await proxyStore();
        try { db.prepare('UPDATE cooldowns SET ready_at = MAX(ready_at, ?) WHERE id = ?').run(Date.now() + 900_000, proxy.id); }
        finally { db.close(); }
        failures.push(error.code);
      }
    }
    throw new SearchError('exhausted', `Search failed after ${failures.length} proxy attempts: ${failures.join(', ')}.`);
  };
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
    db.prepare('UPDATE cooldowns SET ready_at = ? WHERE id = ?').run(readyAt + 180_000, row.id);
    db.exec('COMMIT');
    return { id: row.id, readyAt };
  } finally {
    db.close();
  }
}

export const search = createSearch();

export async function search100(query) {
  const results = new Map();
  let nextStart = 0;
  let pages = 0;
  while (pages < 10 && nextStart !== null && results.size < 100) {
    const page = await search(query, nextStart);
    pages++;
    for (const result of page.results) {
      if (!results.has(result.url)) results.set(result.url, result);
    }
    nextStart = page.nextStart;
  }
  return { query, results: [...results.values()].slice(0, 100), pages, nextStart };
}
