import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, char: string) => {
    if (char === 'n') return '\n'
    if (char === 'r') return '\r'
    if (char === 't') return '\t'
    return char
  })
}

function parseValue(raw: string): string {
  const value = raw.trim()
  if (!value) return ''

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1)
    return end === -1 ? value.slice(1) : value.slice(1, end)
  }

  if (value.startsWith('"')) {
    let escaped = false
    for (let i = 1; i < value.length; i += 1) {
      const char = value[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') return unescapeDoubleQuoted(value.slice(1, i))
    }
    return unescapeDoubleQuoted(value.slice(1))
  }

  return value.replace(/\s+#.*$/, '').trim()
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line)
    if (!match) continue
    const key = match[1]
    if (!key) continue
    const raw = match[2] ?? ''
    if (env[key] !== undefined) continue
    env[key] = parseValue(raw)
  }
}

export function loadPackageEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  loadEnvFile(resolve(root, '.env'))
}
