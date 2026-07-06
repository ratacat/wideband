import { expect, test } from 'bun:test'

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

  const init = replies[0] as { id: number; result: { protocolVersion: string; serverInfo: { name: string; version: string } } }
  expect(init.id).toBe(1)
  expect(init.result.protocolVersion).toBe('2025-03-26')
  expect(init.result.serverInfo.name).toBe('wideband')
  expect(init.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/)

  const list = replies[1] as { id: number; result: { tools: { name: string }[] } }
  expect(list.id).toBe(2)
  expect(list.result.tools.map((t) => t.name)).toEqual(['scan', 'research', 'providers'])

  const unknown = replies[2] as { id: number; error: { code: number } }
  expect(unknown.id).toBe(3)
  expect(unknown.error.code).toBe(-32601)
})
