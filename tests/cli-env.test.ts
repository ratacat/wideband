import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFile } from '../src/cli/env'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CLI env loading', () => {
  test('loads dotenv values without overriding exported env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wideband-env-'))
    tempDirs.push(dir)
    const path = join(dir, '.env')
    writeFileSync(
      path,
      [
        'EXISTING_API_KEY=from-file',
        'PLAIN_API_KEY=plain # comment',
        'export QUOTED_API_KEY="quoted value"',
        "SINGLE_API_KEY='single quoted'",
      ].join('\n'),
    )
    const env: NodeJS.ProcessEnv = { EXISTING_API_KEY: 'from-shell' }

    loadEnvFile(path, env)

    expect(env.EXISTING_API_KEY).toBe('from-shell')
    expect(env.PLAIN_API_KEY).toBe('plain')
    expect(env.QUOTED_API_KEY).toBe('quoted value')
    expect(env.SINGLE_API_KEY).toBe('single quoted')
  })
})
