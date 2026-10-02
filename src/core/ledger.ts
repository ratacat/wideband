import { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import {
  parseSweepResult,
  type AttemptFinish,
  type AttemptStart,
  type SweepResult,
  type UnifiedQuery,
} from './types'
import { roundUSD } from './cost'

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
  providers: Record<string, { attempts: number; usd: number; unknownAttempts: number }>
  totalUSD: number
  unknownAttempts: number
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
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null
}

export class Ledger {
  readonly path: string
  private readonly db: Database

  constructor(path = process.env.WIDEBAND_DB ?? DEFAULT_DB) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    try {
      this.db.run('PRAGMA busy_timeout = 5000')
      const journalMode = this.db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
        .get()?.journal_mode
      if (journalMode !== 'wal') {
        const deadline = Date.now() + 5000
        for (;;) {
          try {
            this.db.run('PRAGMA journal_mode = WAL')
            break
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'SQLITE_BUSY' ||
              Date.now() >= deadline
            )
              throw error
            Bun.sleepSync(10)
          }
        }
      }
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate() {
    const migrate = this.db.transaction(() => {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS sweeps (id TEXT PRIMARY KEY, ts INTEGER, kind TEXT, query_json TEXT, total_hits INTEGER, unique_sources INTEGER, total_usd REAL, total_ms INTEGER, status TEXT NOT NULL DEFAULT 'complete', unknown_attempts INTEGER NOT NULL DEFAULT 0, accounting_version INTEGER NOT NULL DEFAULT 0)",
      )
      const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(sweeps)').all()
      if (!columns.some((column) => column.name === 'status'))
        this.db.run("ALTER TABLE sweeps ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'")
      if (!columns.some((column) => column.name === 'unknown_attempts'))
        this.db.run('ALTER TABLE sweeps ADD COLUMN unknown_attempts INTEGER NOT NULL DEFAULT 0')
      if (!columns.some((column) => column.name === 'accounting_version')) {
        this.db.run('ALTER TABLE sweeps ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 0')
      }
      this.db.run(
        'CREATE TABLE IF NOT EXISTS calls (sweep_id TEXT, provider TEXT, status TEXT, hits INTEGER, unique_contributed INTEGER, latency_ms INTEGER, usd REAL, cost_basis TEXT, error_code TEXT)',
      )
      this.db.run(
        'CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, sweep_id TEXT NOT NULL, provider TEXT NOT NULL, request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, estimate_micro_usd INTEGER NOT NULL, cost_basis TEXT NOT NULL, charge_kind TEXT NOT NULL, charge_micro_usd INTEGER, http_status INTEGER, error_code TEXT, UNIQUE(sweep_id, provider, request_id, ordinal))',
      )
      this.db.run('CREATE INDEX IF NOT EXISTS attempts_sweep ON attempts(sweep_id)')
      this.db.run('CREATE INDEX IF NOT EXISTS attempts_started ON attempts(started_at)')
      this.db.run(
        'CREATE TABLE IF NOT EXISTS cache (query_hash TEXT PRIMARY KEY, ts INTEGER, result_json TEXT)',
      )
      this.db.run(
        'CREATE TABLE IF NOT EXISTS seen (session_id TEXT, source_id TEXT, ts INTEGER, PRIMARY KEY(session_id, source_id))',
      )
    })
    migrate.immediate()
  }

  beginSweep(input: { sweepId: string; query: UnifiedQuery; kind: 'sweep' | 'doctor' }) {
    this.db
      .prepare(
        "INSERT INTO sweeps (id, ts, kind, query_json, total_hits, unique_sources, total_usd, total_ms, status, accounting_version) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'running', 1)",
      )
      .run(input.sweepId, Date.now(), input.kind, JSON.stringify(input.query))
  }

  startAttempt(input: AttemptStart) {
    this.db
      .prepare(
        "INSERT INTO attempts (id,sweep_id,provider,request_id,ordinal,started_at,status,estimate_micro_usd,cost_basis,charge_kind) VALUES (?,?,?,?,?,?,'pending',?,?,'unknown')",
      )
      .run(
        input.attemptId,
        input.sweepId,
        input.provider,
        input.requestId,
        input.ordinal,
        input.startedAt,
        input.estimateMicroUSD,
        input.basis,
      )
  }

  finishAttempt(input: AttemptFinish) {
    const amount = input.charge.kind === 'unknown' ? null : input.charge.microUSD
    this.db
      .prepare(
        'UPDATE attempts SET finished_at=?,status=?,charge_kind=?,charge_micro_usd=?,http_status=?,error_code=? WHERE id=?',
      )
      .run(
        input.finishedAt,
        input.status,
        input.charge.kind,
        amount,
        input.httpStatus ?? null,
        input.errorCode ?? null,
        input.attemptId,
      )
  }

  finishSweep(
    result: SweepResult,
    kind: 'sweep' | 'doctor',
    status: 'complete' | 'partial' | 'failed' | 'cancelled' = result.complete
      ? 'complete'
      : 'partial',
  ) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO sweeps (id,ts,kind,query_json,total_hits,unique_sources,total_usd,total_ms,status,unknown_attempts,accounting_version) VALUES (?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET total_hits=excluded.total_hits,unique_sources=excluded.unique_sources,total_usd=excluded.total_usd,total_ms=excluded.total_ms,status=excluded.status,unknown_attempts=excluded.unknown_attempts',
        )
        .run(
          result.sweepId,
          Date.now(),
          kind,
          JSON.stringify(result.query),
          result.stats.totalHits,
          result.stats.uniqueSources,
          result.cost.totalUSD,
          result.timing.totalMs,
          status,
          result.cost.unknownAttempts,
        )
      this.db.prepare('DELETE FROM calls WHERE sweep_id=?').run(result.sweepId)
      const insert = this.db.prepare(
        'INSERT INTO calls (sweep_id,provider,status,hits,unique_contributed,latency_ms,usd,cost_basis,error_code) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      for (const [provider, stats] of Object.entries(result.stats.providers)) {
        const cost = result.cost.byProvider[provider]
        insert.run(
          result.sweepId,
          provider,
          stats.status,
          stats.hits,
          stats.uniqueContributed,
          stats.latencyMs,
          cost?.usd ?? 0,
          cost?.basis ?? 'free',
          stats.error?.code ?? null,
        )
      }
    })
    tx()
  }

  cacheGet(hash: string, ttlSec: number): SweepResult | null {
    if (ttlSec < 0) return null
    const row = this.db
      .query<CacheRow, [string]>('SELECT ts,result_json FROM cache WHERE query_hash=?')
      .get(hash)
    if (!row || Date.now() - row.ts > ttlSec * 1000) return null
    let result: SweepResult
    try {
      result = parseSweepResult(JSON.parse(row.result_json))
    } catch {
      return null
    }
    if (
      !result.complete ||
      !Object.values(result.stats.providers).some((stats) => stats.status === 'ok') ||
      Object.values(result.stats.providers).some((stats) =>
        ['partial', 'error', 'timeout', 'cancelled', 'skipped:budget'].includes(stats.status),
      )
    )
      return null
    return result
  }

  cachePut(hash: string, result: SweepResult) {
    if (!result.complete) return
    this.db
      .prepare('INSERT OR REPLACE INTO cache (query_hash,ts,result_json) VALUES (?,?,?)')
      .run(hash, Date.now(), JSON.stringify(result))
  }

  seenIds(session: string): Set<string> {
    return new Set(
      this.db
        .query<{ source_id: string }, [string]>('SELECT source_id FROM seen WHERE session_id=?')
        .all(session)
        .map((row) => row.source_id),
    )
  }

  claimSources(session: string, ids: readonly string[]): Set<string> {
    const claim = this.db.transaction(() => {
      const claimed = new Set<string>()
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO seen (session_id,source_id,ts) VALUES (?,?,?)',
      )
      const now = Date.now()
      for (const id of ids) if (stmt.run(session, id, now).changes > 0) claimed.add(id)
      return claimed
    })
    return claim()
  }

  stats(days = 30): LedgerStats {
    const rows = this.db
      .query<StatsRow, [number]>(
        "SELECT calls.provider,calls.status,calls.hits,calls.unique_contributed,calls.latency_ms,calls.usd FROM calls JOIN sweeps ON sweeps.id=calls.sweep_id WHERE sweeps.kind='sweep' AND sweeps.ts>=?",
      )
      .all(Date.now() - days * 86400000)
    const grouped = new Map<
      string,
      {
        calls: number
        errors: number
        hits: number
        unique: number
        usd: number
        latencies: number[]
      }
    >()
    for (const row of rows) {
      if (row.status.startsWith('skipped:')) continue
      const group = grouped.get(row.provider) ?? {
        calls: 0,
        errors: 0,
        hits: 0,
        unique: 0,
        usd: 0,
        latencies: [],
      }
      group.calls += 1
      if (row.status !== 'ok') group.errors += 1
      group.hits += row.hits
      group.unique += row.unique_contributed
      group.usd += row.usd
      if (row.status === 'ok') group.latencies.push(row.latency_ms)
      grouped.set(row.provider, group)
    }
    return Object.fromEntries(
      [...grouped].map(([provider, group]) => [
        provider,
        {
          calls: group.calls,
          errorRate: roundUSD(group.errors / group.calls),
          hits: group.hits,
          uniqueContributed: group.unique,
          uniqueRate: group.hits ? roundUSD(group.unique / group.hits) : 0,
          usd: roundUSD(group.usd),
          costPerUniqueSource: group.unique ? roundUSD(group.usd / group.unique) : null,
          latency: { p50: percentile(group.latencies, 50), p95: percentile(group.latencies, 95) },
        },
      ]),
    )
  }

  monthToDate(): MonthToDate {
    const date = new Date()
    const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    const rows = this.db
      .query<
        { provider: string; calls: number; usd: number; unknown_attempts: number },
        [number, number]
      >(
        `SELECT provider,SUM(calls) AS calls,SUM(usd) AS usd,SUM(unknown_attempts) AS unknown_attempts FROM (SELECT provider,COUNT(*) AS calls,SUM(COALESCE(charge_micro_usd,estimate_micro_usd))/1000000.0 AS usd,SUM(CASE WHEN charge_kind='unknown' THEN 1 ELSE 0 END) AS unknown_attempts FROM attempts WHERE started_at>=? GROUP BY provider UNION ALL SELECT calls.provider,COUNT(*),SUM(calls.usd),0 FROM calls JOIN sweeps ON sweeps.id=calls.sweep_id WHERE sweeps.ts>=? AND sweeps.accounting_version=0 AND NOT EXISTS(SELECT 1 FROM attempts WHERE attempts.sweep_id=sweeps.id) AND calls.status NOT LIKE 'skipped:%' GROUP BY calls.provider) GROUP BY provider`,
      )
      .all(start, start)
    const providers: MonthToDate['providers'] = {}
    let totalUSD = 0
    let unknownAttempts = 0
    for (const row of rows) {
      providers[row.provider] = {
        attempts: row.calls,
        usd: roundUSD(row.usd),
        unknownAttempts: row.unknown_attempts,
      }
      totalUSD += row.usd
      unknownAttempts += row.unknown_attempts
    }
    return { providers, totalUSD: roundUSD(totalUSD), unknownAttempts }
  }

  close() {
    this.db.close()
  }
}
