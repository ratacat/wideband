#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { loadPackageEnv } from '../cli/env'
import { wideband } from '../index'

loadPackageEnv()
const wb = wideband()
const pkg = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')))

const SearchArgs = z.object({
  q: z.string().min(1),
  max: z.number().int().min(1).max(100).optional(),
  googlePages: z.number().int().min(1).max(10).optional(),
  providers: z.array(z.string()).optional(),
  budget: z.number().positive().optional(),
  hours: z.number().positive().optional(),
})

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'Search query' },
    max: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results per provider (default 10, or 10 per requested Google page)' },
    googlePages: { type: 'integer', minimum: 1, maximum: 10, description: 'Google page limit, default 1. Google is included unless providers explicitly excludes it.' },
    providers: { type: 'array', items: { type: 'string' }, description: 'Restrict the sweep to these provider names' },
    budget: { type: 'number', description: 'Hard USD cap for the sweep; cheapest providers first' },
    hours: { type: 'number', description: 'Only content published within the last N hours' },
  },
  required: ['q'],
}

const TOOLS = [
  {
    name: 'scan',
    description:
      'Fast multi-provider web search: one query fanned out across every configured search provider (Exa, Tavily, Brave, Linkup, ...), deduplicated into unique sources with provenance and cost. Use for source discovery.',
    inputSchema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: 'research',
    description:
      'Richer multi-provider web search: advanced provider depth and full page text where supported. Slower and costlier than scan; use when you need content, not just sources.',
    inputSchema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: 'providers',
    description: 'List configured search providers with key/quota status.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function runSearch(mode: 'scan' | 'research', args: unknown) {
  const a = SearchArgs.parse(args)
  const query = {
    q: a.q,
    ...(a.max !== undefined ? { max: a.max } : a.googlePages !== undefined ? { max: a.googlePages * 10 } : {}),
    ...(a.googlePages !== undefined ? { googlePages: a.googlePages } : {}),
    ...(a.hours !== undefined
      ? { freshness: { after: new Date(Date.now() - a.hours * 60 * 60 * 1000).toISOString() } }
      : {}),
  }
  const opts = {
    ...(a.providers ? { providers: a.providers } : {}),
    ...(a.budget !== undefined ? { budget: a.budget } : {}),
  }
  const result = mode === 'scan' ? await wb.scan(query, opts) : await wb.research(query, opts)
  return {
    sources: result.sources.map((s) => ({
      url: s.url,
      title: s.title,
      snippet: s.snippet,
      publishedAt: s.publishedAt,
      providers: s.providers,
      score: s.score,
    })),
    stats: result.stats,
    cost: result.cost,
  }
}

async function callTool(name: string, args: unknown): Promise<unknown> {
  if (name === 'scan' || name === 'research') return runSearch(name, args)
  if (name === 'providers') return wb.providers()
  throw new Error(`unknown tool: ${name}`)
}

const Message = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
})

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

async function handle(line: string) {
  let msg: z.infer<typeof Message>
  try {
    msg = Message.parse(JSON.parse(line))
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const { id, method, params } = msg
  if (method === undefined || id === undefined) return

  if (method === 'initialize') {
    const requested =
      params !== null && typeof params === 'object' && 'protocolVersion' in params && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : '2024-11-05'
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'wideband', version: pkg.version },
      },
    })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const call = z.object({ name: z.string(), arguments: z.unknown().optional() }).safeParse(params)
    if (!call.success) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params' } })
      return
    }
    try {
      const out = await callTool(call.data.name, call.data.arguments ?? {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } })
    }
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim()) void handle(line)
})
rl.on('close', () => {
  wb.close()
  process.exit(0)
})
