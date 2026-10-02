import { expect, test } from 'bun:test'

const initialize = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } }
const search = (id: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'scan', arguments: { q: 'fixture', providers: ['brave'] } } })

function fixtureProcess(origin: string) {
  return Bun.spawn(['bun', '--preload', './testing/fixture-fetch.ts', 'src/mcp/main.ts'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, WIDEBAND_DB: ':memory:', WIDEBAND_FIXTURE_ORIGIN: origin, BRAVE_API_KEY: 'fixture' },
  })
}

async function repliesFrom(proc: ReturnType<typeof fixtureProcess>): Promise<unknown[]> {
  const output = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(await new Response(proc.stderr).text()).toBe('')
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function replyWithId(replies: unknown[], id: string) {
  return replies.find(reply => reply !== null && typeof reply === 'object' && 'id' in reply && reply.id === id)
}

async function rpc(lines: string[]): Promise<unknown[]> {
  const proc = Bun.spawn(['bun', 'src/mcp/main.ts'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, WIDEBAND_DB: ':memory:' },
  })
  proc.stdin.write(`${lines.join('\n')}\n`)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

test('mcp handshake and tools/list', async () => {
  const replies = await rpc([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }),
  ])
  expect(replies).toHaveLength(3)

  expect(replies[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: {} },
    serverInfo: { name: 'wideband', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
  } })
  expect(replies[1]).toMatchObject({ id: 2, result: { tools: [{ name: 'scan' }, { name: 'research' }, { name: 'providers' }] } })
  expect(replies[2]).toMatchObject({ id: 3, error: { code: -32601 } })
})

test('mcp negotiates protocol versions and rejects malformed requests', async () => {
  const replies = await rpc([
    '{',
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }),
  ])
  expect(replies).toHaveLength(4)
  expect(replies[0]).toMatchObject({ id: null, error: { code: -32700 } })
  expect(replies[1]).toMatchObject({ id: 0, error: { code: -32000 } })
  expect(replies[2]).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25' } })
  expect(replies[3]).toMatchObject({ id: 2, error: { code: -32602 } })
})

test('mcp rejects invalid integer and finite limits before search', async () => {
  const invalid = [{ max: 0 }, { max: 101 }, { max: 1.5 }, { max: null }, { googlePages: 11 }, { hours: 0 }, { budget: null }]
  const replies = await rpc([
    JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } }),
    ...invalid.map((args, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'scan', arguments: { q: 'fixture', ...args } } })),
  ])
  expect(replies).toHaveLength(invalid.length + 1)
  for (const reply of replies.slice(1)) expect(reply).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Invalid tool arguments') }] } })
})

test('mcp completes pending provider queries before exiting on EOF', async () => {
  const replies = await rpc([
    JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'providers', method: 'tools/call', params: { name: 'providers' } }),
  ])
  expect(replies).toHaveLength(2)
  expect(replies[1]).toMatchObject({ id: 'providers', result: { content: [{ type: 'text', text: expect.stringContaining('anyapi') }] } })
})

test('mcp awaits an active HTTP search after stdin reaches EOF', async () => {
  let requests = 0
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    requests++
    await Bun.sleep(80)
    return Response.json({ web: { results: [{ url: 'https://fixture.test/eof', title: 'EOF result' }] } })
  } })
  const proc = fixtureProcess(server.url.toString())
  try {
    proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(search('search'))}\n`)
    await proc.stdin.end()
    const replies = await repliesFrom(proc)
    expect(requests).toBe(1)
    expect(replyWithId(replies, 'search')).toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('https://fixture.test/eof') }] } })
  } finally {
    proc.kill()
    server.stop(true)
  }
})

test('mcp cancels one request while a coalesced request completes', async () => {
  let requests = 0
  let notifyStarted = () => {}
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    requests++
    notifyStarted()
    await Bun.sleep(120)
    return Response.json({ web: { results: [{ url: 'https://fixture.test/shared', title: 'Shared result' }] } })
  } })
  const proc = fixtureProcess(server.url.toString())
  try {
    proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(search('cancelled'))}\n${JSON.stringify(search('survivor'))}\n`)
    await started
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancelled' } })}\n`)
    await proc.stdin.end()
    const replies = await repliesFrom(proc)
    expect(requests).toBe(1)
    expect(replyWithId(replies, 'cancelled')).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: 'Search cancelled' }] } })
    expect(replyWithId(replies, 'survivor')).toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('https://fixture.test/shared') }] } })
  } finally {
    proc.kill()
    server.stop(true)
  }
})

test('mcp SIGTERM cancels active HTTP work and shuts down cleanly', async () => {
  let requests = 0
  let notifyStarted = () => {}
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    requests++
    notifyStarted()
    await Bun.sleep(2_000)
    return Response.json({ web: { results: [] } })
  } })
  const proc = fixtureProcess(server.url.toString())
  try {
    proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(search('search'))}\n`)
    await started
    const before = performance.now()
    proc.kill('SIGTERM')
    const replies = await repliesFrom(proc)
    expect(performance.now() - before).toBeLessThan(1_000)
    expect(requests).toBe(1)
    expect(replyWithId(replies, 'search')).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: 'Search cancelled' }] } })
  } finally {
    proc.kill()
    server.stop(true)
  }
})

test('mcp returns a failed tool envelope for wrong-shaped provider JSON', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ wrong: 'provider envelope' }) })
  const proc = fixtureProcess(server.url.toString())
  try {
    proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(search('search'))}\n`)
    await proc.stdin.end()
    const replies = await repliesFrom(proc)
    expect(replyWithId(replies, 'search')).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('invalid_response') }] } })
  } finally {
    proc.kill()
    server.stop(true)
  }
})
