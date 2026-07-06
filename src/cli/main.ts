#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ADAPTERS } from '../adapters/registry'
import { Engine } from '../core/engine'
import { Ledger } from '../core/ledger'
import { FreshnessPolicy, Source, SweepResult, UnifiedQuery, type Source as SourceType, type SweepOptions } from '../core/types'
import { WidebandError } from '../core/errors'
import { loadPackageEnv } from './env'

loadPackageEnv()

const HELP = `wideband — fan-out search across providers, merged unique sources
  scan <query>      fast source discovery  [--providers a,b --max N --hours N --freshness balanced --fresh --json]
  research <query>  richer provider retrieval, slower and costlier
  providers       adapters + key/quota status
  stats           uniqueness, cost/unique-source, latency by provider
  costs           month-to-date spend
  doctor          live-validate keys
  schema [type]   JSON Schema for outputs
flags:
  --hours N       filter to content published within the last N hours
  --after VALUE   filter to content after an ISO timestamp or YYYY-MM-DD
  --before VALUE  filter to content before an ISO timestamp or YYYY-MM-DD
  --freshness MODE strict, balanced, or recall; default balanced
  --fresh         bypass the TTL cache
exit: 0 ok · 1 no results · 2 bad args · 3 config · 4 budget · 5 all failed`

const FIELD_NAMES = Source.keyof().options as (keyof SourceType)[]
const DEFAULT_FIELDS: (keyof SourceType)[] = ['id', 'url', 'title', 'snippet', 'publishedAt', 'providers', 'freshness', 'score']

const options = {
  providers: { type: 'string' },
  max: { type: 'string' },
  budget: { type: 'string' },
  timeout: { type: 'string' },
  session: { type: 'string' },
  fresh: { type: 'boolean' },
  ttl: { type: 'string' },
  fields: { type: 'string' },
  full: { type: 'boolean' },
  capture: { type: 'boolean' },
  json: { type: 'boolean' },
  pretty: { type: 'boolean' },
  media: { type: 'string' },
  days: { type: 'string' },
  after: { type: 'string' },
  before: { type: 'string' },
  hours: { type: 'string' },
  freshness: { type: 'string' },
  h: { type: 'boolean', short: 'h' },
  help: { type: 'boolean' },
} as const

type CliValues = {
  providers?: string
  max?: string
  budget?: string
  timeout?: string
  session?: string
  fresh?: boolean
  ttl?: string
  fields?: string
  full?: boolean
  capture?: boolean
  json?: boolean
  pretty?: boolean
  media?: string
  days?: string
  after?: string
  before?: string
  hours?: string
  freshness?: string
  h?: boolean
  help?: boolean
}

type Parsed = { values: CliValues; positionals: string[] }
type DoctorCheck = { provider: string; status: string; latencyMs?: number; error?: { code: string; message: string } }

function wantsJSON(values: Parsed['values']) {
  if (values.json) return true
  if (values.pretty) return false
  return !process.stdout.isTTY
}

function writeOutput(value: unknown, values: Parsed['values'], pretty: () => string) {
  if (wantsJSON(values)) {
    console.log(JSON.stringify(value, null, 2))
  } else {
    console.log(pretty())
  }
}

function fail(error: unknown): never {
  const wb =
    error instanceof WidebandError
      ? error
      : error instanceof z.ZodError
        ? new WidebandError(
            'INVALID_ARGS',
            error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '),
            ['run: wideband --help'],
            2,
          )
      : new WidebandError('INTERNAL', error instanceof Error ? error.message : 'Internal error', [], 1)
  console.error(JSON.stringify({ error: { code: wb.code, message: wb.message, suggestions: wb.suggestions } }, null, 2))
  process.exit(wb.exitCode)
}

function invalid(message: string): never {
  throw new WidebandError('INVALID_ARGS', message, ['run: wideband --help'], 2)
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function numberFlag(value: string | undefined, name: string, bounds: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) invalid(`${name} must be a number`)
  if (bounds.min !== undefined && n < bounds.min) invalid(`${name} must be >= ${bounds.min}`)
  if (bounds.max !== undefined && n > bounds.max) invalid(`${name} must be <= ${bounds.max}`)
  return n
}

function intFlag(value: string | undefined, name: string, bounds: { min?: number; max?: number } = {}): number | undefined {
  const n = numberFlag(value, name, bounds)
  if (n === undefined) return undefined
  if (!Number.isInteger(n)) invalid(`${name} must be an integer`)
  return n
}

function buildSweepOptions(values: Parsed['values']): SweepOptions {
  return {
    ...(values.providers ? { providers: splitList(values.providers) } : {}),
    ...(values.budget !== undefined ? { budget: numberFlag(values.budget, '--budget', { min: 0 }) } : {}),
    ...(values.timeout !== undefined ? { timeoutMs: intFlag(values.timeout, '--timeout', { min: 1 }) } : {}),
    ...(values.session ? { session: values.session } : {}),
    ...(values.fresh ? { fresh: true } : {}),
    ...(values.ttl !== undefined ? { ttlSec: intFlag(values.ttl, '--ttl', { min: 0 }) } : {}),
    ...(values.capture ? { capture: true } : {}),
  }
}

function buildFreshness(values: Parsed['values']) {
  if (values.hours !== undefined && values.after !== undefined) invalid('--hours and --after cannot be used together')
  const hours = numberFlag(values.hours, '--hours', { min: 0 })
  if (hours !== undefined && hours <= 0) invalid('--hours must be > 0')
  const now = Date.now()
  const before = values.before ?? (hours !== undefined ? new Date(now).toISOString() : undefined)
  const beforeTime = values.before ? Date.parse(values.before) : now
  if (hours !== undefined && Number.isNaN(beforeTime)) invalid('--before must be parseable when used with --hours')
  const after = values.after ?? (hours !== undefined ? new Date(beforeTime - hours * 60 * 60 * 1000).toISOString() : undefined)
  if (!after && !before) return undefined
  return {
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
  }
}

function buildFreshnessPolicy(values: Parsed['values']) {
  if (values.freshness === undefined) return undefined
  const parsed = FreshnessPolicy.safeParse(values.freshness)
  if (!parsed.success) invalid('--freshness must be one of: strict, balanced, recall')
  return parsed.data
}

function projectionFields(values: Parsed['values']): (keyof SourceType)[] {
  if (values.full) return FIELD_NAMES
  const fields = values.fields ? splitList(values.fields) : DEFAULT_FIELDS
  const invalidFields = (fields ?? []).filter((field) => !FIELD_NAMES.includes(field as keyof SourceType))
  if (invalidFields.length) invalid(`Unknown source field: ${invalidFields.join(', ')}`)
  return fields as (keyof SourceType)[]
}

function truncateSnippet(value: unknown, full: boolean) {
  if (typeof value !== 'string' || full || value.length <= 280) return value
  return `${value.slice(0, 277)}...`
}

function projectSource(source: SourceType, fields: (keyof SourceType)[], full: boolean) {
  const out: Partial<SourceType> = {}
  for (const field of fields) {
    const value = field === 'snippet' ? truncateSnippet(source[field], full) : source[field]
    if (value !== undefined) Object.assign(out, { [field]: value })
  }
  return out
}

function projectSearchResult(result: SweepResult, values: Parsed['values']) {
  if (values.full) return result
  const fields = projectionFields(values)
  return {
    ...result,
    sources: result.sources.map((source) => projectSource(source, fields, Boolean(values.full))),
  }
}

function prettyProviderStats(result: SweepResult) {
  const lines = Object.entries(result.stats.providers).map(([name, stats]) => {
    const freshness = stats.freshness
      ? `, freshness ${stats.freshness.support}/${stats.freshness.policy}, kept ${stats.freshness.kept}, undated ${stats.freshness.keptUndated}, stale kept ${stats.freshness.keptStale}, stale dropped ${stats.freshness.droppedStale}, undated dropped ${stats.freshness.droppedUndated}`
      : ''
    return `${name}: ${stats.status}, hits ${stats.hits}, unique ${stats.uniqueContributed}${freshness}`
  })
  return lines.length ? `\n\nproviders:\n${lines.join('\n')}` : ''
}

function prettySearch(result: SweepResult) {
  const lines = result.sources.map((source, i) => `${i + 1}. ${source.title}\n   ${source.url}`)
  return `${lines.length ? lines.join('\n') : 'no results'}${prettyProviderStats(result)}`
}

function prettyProviders(providers: ReturnType<Engine['providerInfo']>) {
  return providers
    .map((p) => {
      const quota = p.quota ? ` quota ${p.quota.used}/${p.quota.limit}` : ''
      return `${p.name}: ${p.keyPresent ? 'key' : 'missing'} ${p.costModel.kind}${quota}`
    })
    .join('\n')
}

async function run() {
  let parsed: Parsed
  try {
    parsed = parseArgs({ options, allowPositionals: true, strict: true }) as Parsed
  } catch (error) {
    throw new WidebandError('INVALID_ARGS', error instanceof Error ? error.message : 'Invalid arguments', ['run: wideband --help'], 2)
  }

  const { values, positionals } = parsed
  if (values.help || values.h) {
    console.log(HELP)
    return 0
  }
  const command = positionals[0]
  if (!command) {
    console.log(HELP)
    return 0
  }

  if (command === 'schema') {
    const name = positionals[1] ?? 'SweepResult'
    const schemas = { SweepResult, Source, UnifiedQuery }
    const schema = schemas[name as keyof typeof schemas]
    if (!schema) invalid(`Unknown schema: ${name}`)
    console.log(JSON.stringify((z as unknown as { toJSONSchema: (schema: unknown) => unknown }).toJSONSchema(schema), null, 2))
    return 0
  }

  const ledger = new Ledger()
  const engine = new Engine(ADAPTERS, ledger)
  try {
    if (command === 'scan' || command === 'research') {
      const q = positionals.slice(1).join(' ').trim()
      if (!q) invalid(`${command} requires a query`)
      const max = intFlag(values.max, '--max', { min: 1, max: 50 })
      const freshness = buildFreshness(values)
      const freshnessPolicy = buildFreshnessPolicy(values)
      const query = UnifiedQuery.parse({
        q,
        mode: command,
        ...(max !== undefined ? { max } : {}),
        ...(values.media ? { mediaType: values.media } : {}),
        ...(freshness ? { freshness } : {}),
        ...(freshnessPolicy ? { freshnessPolicy } : {}),
      })
      const result = await engine.sweep(query, buildSweepOptions(values))
      const output = projectSearchResult(result, values)
      writeOutput(output, values, () => prettySearch(result))
      if (result.sources.length > 0) return 0
      const nonSkipped = Object.values(result.stats.providers).filter((p) => !p.status.startsWith('skipped:'))
      if (nonSkipped.length > 0 && nonSkipped.every((p) => p.status === 'error' || p.status === 'timeout')) return 5
      return 1
    }

    if (command === 'providers') {
      const providers = engine.providerInfo()
      writeOutput(providers, values, () => prettyProviders(providers))
      return 0
    }

    if (command === 'stats') {
      const stats = ledger.stats(intFlag(values.days, '--days', { min: 1 }) ?? 30)
      writeOutput(stats, values, () =>
        Object.entries(stats)
          .map(([name, s]) => `${name}: calls ${s.calls}, unique ${s.uniqueContributed}, $/unique ${s.costPerUniqueSource ?? 'n/a'}`)
          .join('\n') || 'no stats',
      )
      return 0
    }

    if (command === 'costs') {
      const costs = ledger.monthToDate()
      writeOutput(costs, values, () =>
        [`total: $${costs.totalUSD}`, ...Object.entries(costs.providers).map(([name, c]) => `${name}: ${c.calls} calls, $${c.usd}`)].join('\n'),
      )
      return 0
    }

    if (command === 'doctor') {
      const providers = engine.providerInfo()
      const missingKeys = providers.filter((p) => !p.keyPresent).map((p) => p.envKey)
      const checks: DoctorCheck[] = await Promise.all(
        providers
          .filter((p) => p.keyPresent)
          .map(async (provider) => {
            try {
              const result = await engine.sweep(
                UnifiedQuery.parse({ q: 'wideband connectivity check', max: 1 }),
                { providers: [provider.name], fresh: true, timeoutMs: 8000 },
                'doctor',
              )
              const stats = result.stats.providers[provider.name]
              if (!stats) {
                return {
                  provider: provider.name,
                  status: 'error',
                  error: { code: 'missing_stats', message: 'Provider returned no stats' },
                }
              }
              return {
                provider: provider.name,
                status: stats.status,
                latencyMs: stats.latencyMs,
                ...(stats.error ? { error: stats.error } : {}),
              }
            } catch (error) {
              return {
                provider: provider.name,
                status: 'error',
                error: {
                  code: error instanceof WidebandError ? error.code : 'doctor_error',
                  message: error instanceof Error ? error.message : 'Provider doctor check failed',
                },
              }
            }
          }),
      )
      const output = { checks, missingKeys }
      writeOutput(output, values, () =>
        [
          ...checks.map((c) => `${c.provider}: ${c.status}${c.latencyMs === undefined ? '' : ` ${c.latencyMs}ms`}`),
          ...(missingKeys.length ? [`missing: ${missingKeys.join(', ')}`] : []),
        ].join('\n'),
      )
      return missingKeys.length === 0 && checks.every((c) => c.status === 'ok') ? 0 : 3
    }

    invalid(`Unknown command: ${command}`)
  } finally {
    ledger.close()
  }
}

run()
  .then((code) => process.exit(code))
  .catch(fail)
