import { afterEach, describe, expect, test } from 'bun:test'
import { requestJSON } from '../src/adapters/http'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('requestJSON', () => {
  test('classifies insufficient credits as quota instead of retryable rate limit', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'INSUFFICIENT_FUNDS_CREDITS', message: 'remaining funds 0' }), {
        status: 429,
      })) as unknown as typeof fetch

    await expect(requestJSON('https://example.com', {})).rejects.toMatchObject({
      code: 'quota',
      httpStatus: 429,
    })
  })

  test('sanitizes provider error details', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'Insufficient balance',
          user_id: '767aa28c-57cd-4117-9a44-f2df9e436fec',
          company_id: 'cbc6ae7c-2cfe-4c65-98be-633b24fd74e6',
          api_key_id: '200230f5-e6a5-4fdb-a845-c1c3ff3e62b5',
          debug_token: 'x'.repeat(40),
        }),
        { status: 402 },
      )) as unknown as typeof fetch

    try {
      await requestJSON('https://example.com', {})
      throw new Error('expected requestJSON to throw')
    } catch (error) {
      expect(error).toMatchObject({ code: 'quota', httpStatus: 402 })
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toBe('Provider returned HTTP 402: Insufficient balance')
      expect(message).not.toContain('user_id')
      expect(message).not.toContain('api_key_id')
      expect(message).not.toContain('767aa28c')
    }
  })
})
