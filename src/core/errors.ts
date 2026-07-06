export type AdapterErrorCode = 'auth' | 'quota' | 'rate_limit' | 'timeout' | 'provider_error'

/** Uniform failure mode for adapters — raw provider errors never leave an adapter. */
export class AdapterError extends Error {
  constructor(
    public code: AdapterErrorCode,
    message: string,
    public httpStatus?: number,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

export class WidebandError extends Error {
  constructor(
    public code: string,
    message: string,
    public suggestions: string[] = [],
    public exitCode: number = 1,
  ) {
    super(message)
    this.name = 'WidebandError'
  }
}
