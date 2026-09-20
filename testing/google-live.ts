import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SweepResult } from '../src/core/types'

const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))
const query = 'site:padi.com/dive-center/'

async function invoke(args: string[]) {
  const child = spawn('bun', [cli, ...args, '--full'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}

async function scan(args: string[]) {
  const result = await invoke(['scan', query, '--providers', 'google', ...args])
  assert.equal(result.code, 0, result.stderr || result.stdout)
  const data = SweepResult.parse(JSON.parse(result.stdout))
  assert.equal(data.stats.providers.google?.status, 'ok')
  assert(data.sources.every(source => source.providers.includes('google')))
  return data
}

const shallow = await scan(['--max', '100', '--fresh'])
assert(shallow.sources.length > 0 && shallow.sources.length <= 10)
const deep = await scan(['--max', '100', '--google-pages', '3', '--fresh'])
assert(!deep.cached)
assert(deep.sources.length > 10 && deep.sources.length <= 30)
const cached = await scan(['--max', '100', '--google-pages', '3'])
assert.equal(cached.cached, true)
assert.equal(cached.sweepId, deep.sweepId)
const cachedShallow = await scan(['--max', '100'])
assert.equal(cachedShallow.sweepId, shallow.sweepId)
assert(cachedShallow.sources.length <= 10)

const hundred = await scan(['--google-pages', '10', '--fresh'])
assert.equal(hundred.query.max, 100)
assert(hundred.sources.length > 30 && hundred.sources.length <= 100)
assert.equal(new Set(hundred.sources.map(source => source.url)).size, hundred.sources.length)

const concurrent = await Promise.all([scan(['--fresh']), scan(['--fresh'])])
assert(concurrent.every(result => result.sources.length > 0))

for (const depth of ['0', '11', '1.5']) {
  const result = await invoke(['scan', query, '--providers', 'google', '--google-pages', depth])
  assert.equal(result.code, 2)
  assert(result.stderr.includes('INVALID_ARGS'))
}
const unselected = await invoke(['scan', query, '--providers', 'brave', '--google-pages', '2'])
assert.equal(unselected.code, 2)
assert(unselected.stderr.includes('requires selecting the google provider'))

const timed = await invoke(['scan', query, '--providers', 'google', '--timeout', '150', '--fresh'])
assert.equal(timed.code, 5)
const timeout = SweepResult.parse(JSON.parse(timed.stdout))
assert.equal(timeout.stats.providers.google?.status, 'timeout')
assert.equal(timeout.sources.length, 0)

const combined = await invoke(['scan', 'site:vipdiving.com', '--providers', 'google,brave', '--fresh'])
assert.equal(combined.code, 0)
const merged = SweepResult.parse(JSON.parse(combined.stdout))
assert.equal(merged.stats.providers.google?.status, 'ok')
assert.equal(merged.stats.providers.brave?.status, 'ok')
assert(merged.sources.some(source => source.providers.includes('google') && source.providers.includes('brave')))

const normal = await invoke(['scan', query, '--max', '1', '--fresh'])
assert.equal(normal.code, 0)
assert.equal(SweepResult.parse(JSON.parse(normal.stdout)).stats.providers.google?.status, 'ok')

process.stdout.write(`${JSON.stringify({ onePage: shallow.sources.length, threePages: deep.sources.length, tenPages: hundred.sources.length, combined: merged.sources.length, cache: 'passed', validation: 'passed', cancellation: 'passed', concurrent: 'passed', defaultGoogle: 'passed' })}\n`)
