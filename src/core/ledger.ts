import { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { SweepResult, type CostBasis } from './types'

export type ProviderRollup = {
  calls: number
  errorRate: number
  hits: number
  uniqueContributed: number
  uniqueRate: number
  usd: number
  costPerUniqueSource: number | null
  latency: { p50: number | null; p95: number | null }
}

export type LedgerStats = Record<string, ProviderRollup>
export type MonthToDate = {
  providers: Record<string, { calls: number; usd: number }>
  totalUSD: number
}

type CacheRow = { ts: number; result_json: string }
type StatsRow = {
  provider: string
  status: string
  hits: number
  unique_contributed: number
  latency_ms: number
  usd: number
}

const DEFAULT_DB = join(homedir(), '.wideband', 'ledger.db')

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx] ?? null
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export class Ledger {
  readonly path: string
  private db: Database

  constructor(path = process.env.WIDEBAND_DB ?? DEFAULT_DB) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.run('PRAGMA busy_timeout = 5000')
    this.db.run('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sweeps (
        id TEXT PRIMARY KEY,
        ts INTEGER,
        kind TEXT,
        query_json TEXT,
        total_hits INTEGER,
        unique_sources INTEGER,
        total_usd REAL,
        total_ms INTEGER
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS calls (
        sweep_id TEXT,
        provider TEXT,
        status TEXT,
        hits INTEGER,
        unique_contributed INTEGER,
        latency_ms INTEGER,
        usd REAL,
        cost_basis TEXT,
        error_code TEXT
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cache (
        query_hash TEXT PRIMARY KEY,
        ts INTEGER,
        result_json TEXT
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS seen (
        session_id TEXT,
        source_id TEXT,
        ts INTEGER,
        PRIMARY KEY (session_id, source_id)
      )
    `)
  }

  recordSweep(result: SweepResult, kind: 'sweep' | 'doctor') {
    const now = Date.now()
    const insertSweep = this.db.prepare(`
      INSERT INTO sweeps (id, ts, kind, query_json, total_hits, unique_sources, total_usd, total_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCall = this.db.prepare(`
      INSERT INTO calls (
        sweep_id, provider, status, hits, unique_contributed, latency_ms, usd, cost_basis, error_code
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      insertSweep.run(
        result.sweepId,
        now,
        kind,
        JSON.stringify(result.query),
        result.stats.totalHits,
        result.stats.uniqueSources,
        result.cost.totalUSD,
        result.timing.totalMs,
      )
      for (const [provider, stats] of Object.entries(result.stats.providers)) {
        const cost = result.cost.byProvider[provider] ?? { usd: 0, basis: 'metered' as CostBasis }
        insertCall.run(
          result.sweepId,
          provider,
          stats.status,
          stats.hits,
          stats.uniqueContributed,
          stats.latencyMs,
          cost.usd,
          cost.basis,
          stats.error?.code ?? null,
        )
      }
    })
    tx()
  }

  cacheGet(hash: string, ttlSec: number): SweepResult | null {
    if (ttlSec < 0) return null
    const row = this.db
      .query<CacheRow, [string]>('SELECT ts, result_json FROM cache WHERE query_hash = ?')
      .get(hash)
    if (!row) return null
    if (Date.now() - row.ts > ttlSec * 1000) return null
    return SweepResult.parse(JSON.parse(row.result_json))
  }

  cachePut(hash: string, result: SweepResult) {
    this.db
      .prepare('INSERT OR REPLACE INTO cache (query_hash, ts, result_json) VALUES (?, ?, ?)')
      .run(hash, Date.now(), JSON.stringify(result))
  }

  seenIds(session: string, ids: string[]): Set<string> {
    const seen = new Set<string>()
    if (ids.length === 0) return seen
    const stmt = this.db.prepare('SELECT 1 FROM seen WHERE session_id = ? AND source_id = ?')
    for (const id of ids) {
      if (stmt.get(session, id)) seen.add(id)
    }
    return seen
  }

  markSeen(session: string, ids: string[]) {
    if (ids.length === 0) return
    const stmt = this.db.prepare('INSERT OR IGNORE INTO seen (session_id, source_id, ts) VALUES (?, ?, ?)')
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(session, id, now)
    })
    tx()
  }

  stats(days = 30): LedgerStats {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = this.db
      .query<StatsRow, [number]>(
        `
        SELECT calls.provider, calls.status, calls.hits, calls.unique_contributed, calls.latency_ms, calls.usd
        FROM calls
        JOIN sweeps ON sweeps.id = calls.sweep_id
        WHERE sweeps.kind = 'sweep' AND sweeps.ts >= ?
      `,
      )
      .all(cutoff)

    const grouped = new Map<
      string,
      { rows: StatsRow[]; calls: number; errors: number; hits: number; unique: number; usd: number; okLatencies: number[] }
    >()
    for (const row of rows) {
      const g =
        grouped.get(row.provider) ??
        { rows: [], calls: 0, errors: 0, hits: 0, unique: 0, usd: 0, okLatencies: [] }
      g.rows.push(row)
      g.calls += 1
      if (row.status === 'error' || row.status === 'timeout') g.errors += 1
      g.hits += row.hits
      g.unique += row.unique_contributed
      g.usd += row.usd
      if (row.status === 'ok') g.okLatencies.push(row.latency_ms)
      grouped.set(row.provider, g)
    }

    const out: LedgerStats = {}
    for (const [provider, g] of grouped) {
      out[provider] = {
        calls: g.calls,
        errorRate: g.calls === 0 ? 0 : round(g.errors / g.calls),
        hits: g.hits,
        uniqueContributed: g.unique,
        uniqueRate: g.hits === 0 ? 0 : round(g.unique / g.hits),
        usd: round(g.usd),
        costPerUniqueSource: g.unique === 0 ? null : round(g.usd / g.unique),
        latency: {
          p50: percentile(g.okLatencies, 50),
          p95: percentile(g.okLatencies, 95),
        },
      }
    }
    return out
  }

  monthToDate(): MonthToDate {
    const d = new Date()
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    const rows = this.db
      .query<{ provider: string; calls: number; usd: number }, [number]>(
        `
        SELECT calls.provider AS provider, COUNT(*) AS calls, COALESCE(SUM(calls.usd), 0) AS usd
        FROM calls
        JOIN sweeps ON sweeps.id = calls.sweep_id
        WHERE sweeps.ts >= ?
        GROUP BY calls.provider
      `,
      )
      .all(start)
    const providers: MonthToDate['providers'] = {}
    let totalUSD = 0
    for (const row of rows) {
      providers[row.provider] = { calls: row.calls, usd: round(row.usd) }
      totalUSD += row.usd
    }
    return { providers, totalUSD: round(totalUSD) }
  }

  close() {
    this.db.close()
  }
}
