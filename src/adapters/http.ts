import { AdapterError } from '../core/errors'
import type { AdapterErrorCode } from '../core/errors'

function redactSensitiveDetails(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
}

function jsonProviderDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return [record.error, record.message, record.code]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, 2)
      .join(': ')
  } catch {
    return undefined
  }
}

function messageFromStatus(status: number, body: string): string {
  const fallback = stripTags(body).replace(/\s+/g, ' ').trim()
  const detail = redactSensitiveDetails(jsonProviderDetail(body) ?? fallback).slice(0, 200)
  return detail ? `Provider returned HTTP ${status}: ${detail}` : `Provider returned HTTP ${status}`
}

function codeForStatus(status: number, body: string): AdapterErrorCode {
  const lower = body.toLowerCase()
  if (status === 402 || (lower.includes('insufficient') && (lower.includes('credit') || lower.includes('fund')))) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'provider_error'
}

export async function requestJSON<T>(url: string, init: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, init)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new AdapterError(codeForStatus(response.status, body), messageFromStatus(response.status, body), response.status)
    }
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new AdapterError('provider_error', error instanceof Error ? error.message : 'Invalid provider JSON')
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AdapterError('timeout', 'Provider request timed out')
    }
    throw new AdapterError('provider_error', error instanceof Error ? error.message : 'Provider request failed')
  }
}

export function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
