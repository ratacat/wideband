import type { AttemptFinish, SweepResult } from './types'

export type AdapterErrorCode =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'provider_error'
  | 'transport'
  | 'invalid_response'
  | 'budget'

export class AdapterError extends Error {
  readonly _tag = 'AdapterError'
  reason?: string
  constructor(
    public code: AdapterErrorCode,
    message: string,
    public httpStatus?: number,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

export class LedgerError extends Error {
  readonly _tag = 'LedgerError'
  constructor(
    public operation: string,
    message: string,
    public attempt?: AttemptFinish,
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

export class WidebandError extends Error {
  readonly _tag = 'WidebandError'
  constructor(
    public code: string,
    message: string,
    public suggestions: readonly string[] = [],
    public exitCode: number = 1,
    public result?: SweepResult,
  ) {
    super(message)
    this.name = 'WidebandError'
  }
}

export function safeErrorMessage(value: unknown, secrets: readonly string[] = []): string {
  let message =
    value instanceof Error ? value.message : typeof value === 'string' ? value : 'Operation failed'
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]')
  return message
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[redacted]',
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .slice(0, 400)
}
