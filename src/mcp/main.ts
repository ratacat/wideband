#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Schema } from 'effect'
import { loadPackageEnv } from '../cli/env'
import { safeErrorMessage, WidebandError } from '../core/errors'
import { SweepOptionsSchema, UnifiedQuery } from '../core/types'
import { wideband } from '../index'

loadPackageEnv()
const wb = wideband()
const pkg = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')),
)

const SearchArgs = Schema.Struct({
  q: UnifiedQuery.fields.q.annotate({ description: 'Search query' }),
  max: Schema.optionalKey(Schema.toType(UnifiedQuery.fields.max)).annotate({ description: 'Max results per provider, default 10 or 10 per requested Google page' }),
  googlePages: UnifiedQuery.fields.googlePages.annotate({ description: 'Google page limit, default 1. Google is included unless providers excludes it.' }),
  providers: SweepOptionsSchema.fields.providers.annotate({ description: 'Restrict the sweep to these provider names' }),
  budget: SweepOptionsSchema.fields.budget.annotate({ description: 'USD cap on modeled request charges; cheapest providers first' }),
  hours: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({ description: 'Only content published within the last N hours' }),
})
const searchSchema = Schema.toJsonSchemaDocument(SearchArgs).schema
const TOOLS = [
  {
    name: 'scan',
    description: 'Fast multi-provider web search, deduplicated into sources with provenance and cost. Use for source discovery.',
    inputSchema: searchSchema,
  },
  {
    name: 'research',
    description: 'Richer multi-provider web search with advanced provider depth and full page text where supported.',
    inputSchema: searchSchema,
  },
  {
    name: 'providers',
    description: 'List search providers with key and quota status.',
    inputSchema: Schema.toJsonSchemaDocument(Schema.Struct({})).schema,
  },
]

async function callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  if (name === 'providers') return wb.providers()
  if (name !== 'scan' && name !== 'research') throw new WidebandError('UNKNOWN_TOOL', `Unknown tool: ${name}`, [], 2)
  const input = Schema.decodeUnknownSync(SearchArgs)(args)
  const query = {
    q: input.q,
    ...(input.max !== undefined ? { max: input.max } : input.googlePages !== undefined ? { max: input.googlePages * 10 } : {}),
    ...(input.googlePages !== undefined ? { googlePages: input.googlePages } : {}),
    ...(input.hours !== undefined ? { freshness: { after: new Date(Date.now() - input.hours * 3_600_000).toISOString() } } : {}),
  }
  const options = {
    ...(input.providers ? { providers: input.providers } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    signal,
  }
  const result = await wb[name](query, options)
  return {
    sources: result.sources.map(source => ({
      url: source.url,
      title: source.title,
      snippet: source.snippet,
      publishedAt: source.publishedAt,
      providers: source.providers,
      score: source.score,
    })),
    stats: result.stats,
    cost: result.cost,
    complete: result.complete,
  }
}

const RequestId = Schema.Union([Schema.Finite, Schema.String])
const Message = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.optionalKey(RequestId),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})
const ToolCall = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) })
const Cancellation = Schema.Struct({ requestId: RequestId })
const Initialize = Schema.Struct({ protocolVersion: Schema.String, capabilities: Schema.Unknown, clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }) })
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const pending = new Map<string | number, { controller: AbortController; done: Promise<void> }>()
let initialized = false
let closing = false

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function rpcError(id: string | number | null, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handle(line: string) {
  let input: unknown
  try {
    input = JSON.parse(line)
  } catch {
    rpcError(null, -32700, 'parse error')
    return
  }
  const parsed = Schema.decodeUnknownResult(Message)(input)
  if (parsed._tag === 'Failure') {
    rpcError(null, -32600, 'invalid request')
    return
  }
  const { id, method, params } = parsed.success
  if (method === 'notifications/cancelled' && id === undefined) {
    const cancellation = Schema.decodeUnknownResult(Cancellation)(params)
    if (cancellation._tag === 'Success') pending.get(cancellation.success.requestId)?.controller.abort()
    return
  }
  if (id === undefined) return
  if (pending.has(id)) {
    rpcError(id, -32600, 'request id is already active')
    return
  }
  if (method === 'initialize') {
    const init = Schema.decodeUnknownResult(Initialize)(params)
    if (init._tag === 'Failure') {
      rpcError(id, -32602, 'invalid initialize params')
      return
    }
    initialized = true
    send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(init.success.protocolVersion) ? init.success.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'wideband', version: pkg.version } } })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (!initialized) {
    rpcError(id, -32000, 'server is not initialized')
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method !== 'tools/call') {
    rpcError(id, -32601, `method not found: ${method}`)
    return
  }
  const call = Schema.decodeUnknownResult(ToolCall)(params)
  if (call._tag === 'Failure') {
    rpcError(id, -32602, 'invalid params')
    return
  }
  const controller = new AbortController()
  const done = callTool(call.success.name, call.success.arguments ?? {}, controller.signal).then(output => {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(output) }] } })
  }, error => {
    const message = Schema.isSchemaError(error) ? `Invalid tool arguments: ${safeErrorMessage(error)}` : safeErrorMessage(error)
    const text = error instanceof WidebandError && error.result
      ? JSON.stringify({ error: { code: error.code, message }, result: error.result })
      : message
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })
  }).finally(() => pending.delete(id))
  pending.set(id, { controller, done })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => { if (!closing && line.trim()) handle(line) })
let shutdown: Promise<void> | undefined
function close(abort: boolean) {
  if (abort) for (const request of pending.values()) request.controller.abort()
  if (!shutdown) {
    closing = true
    shutdown = Promise.allSettled([...pending.values()].map(request => request.done)).then(() => wb.close())
    rl.close()
  }
  return shutdown
}
function finish(abort: boolean) {
  void close(abort).catch(error => { console.error(safeErrorMessage(error)); process.exitCode = 1 })
}
rl.on('close', () => finish(false))
process.once('SIGINT', () => finish(true))
process.once('SIGTERM', () => finish(true))
