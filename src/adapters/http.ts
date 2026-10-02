import { Effect, Result, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { AdapterError } from '../core/errors'
import type { AdapterErrorCode } from '../core/errors'
import type { RequestReceipt } from '../core/types'

export const HttpUrl = Schema.String.check(Schema.makeFilter(value => {
  if (!URL.canParse(value)) return false
  return ['http:', 'https:'].includes(new URL(value).protocol)
}))

export const ReportedUSD = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

function redactSensitiveDetails(value: string, key: string): string {
  const text = key ? value.split(key).join('[redacted]') : value
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
}

const ErrorDetail = Schema.Struct({
  error: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.Unknown),
})

function messageFromStatus(status: number, body: string, key: string): string {
  let detail: string | undefined
  try {
    const decoded = Schema.decodeUnknownResult(ErrorDetail)(JSON.parse(body))
    if (Result.isSuccess(decoded)) {
      detail = [decoded.success.error, decoded.success.message, decoded.success.code]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .slice(0, 2)
        .join(': ')
    }
  } catch {}
  const text = redactSensitiveDetails(detail || stripTags(body), key).replace(/\s+/g, ' ').trim().slice(0, 200)
  return text ? `Provider returned HTTP ${status}: ${text}` : `Provider returned HTTP ${status}`
}

function codeForStatus(status: number, body: string): AdapterErrorCode {
  const lower = body.toLowerCase()
  if (status === 402 || lower.includes('quota') || (lower.includes('insufficient') && (lower.includes('credit') || lower.includes('fund')))) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'provider_error'
}

function retryDelay(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined
}

export function requestJSON<A>(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  schema: Schema.ConstraintDecoder<A>,
  key: string,
  reportedUSD?: (body: unknown) => Result.Result<number | undefined, Schema.SchemaError>,
): Effect.Effect<RequestReceipt<A>, AdapterError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    let request = init.method === 'POST' ? HttpClientRequest.post(url) : HttpClientRequest.get(url)
    if (init.headers) request = HttpClientRequest.setHeaders(request, Object.fromEntries(new Headers(init.headers)))
    if (typeof init.body === 'string') request = HttpClientRequest.bodyText(request, init.body, 'application/json')
    const response = yield* HttpClient.execute(request).pipe(Effect.mapError(() => new AdapterError('transport', 'Provider request failed')))
    const text = yield* response.text.pipe(Effect.mapError(() => new AdapterError('transport', 'Provider response could not be read')))
    const json = yield* Effect.result(Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new AdapterError('invalid_response', 'Provider returned invalid JSON'),
    }))
    let reportedMicroUSD: number | undefined
    let costError: AdapterError | undefined
    if (reportedUSD && Result.isSuccess(json)) {
      const cost = reportedUSD(json.success)
      if (Result.isFailure(cost)) costError = new AdapterError('invalid_response', 'Provider returned invalid reported cost')
      else if (cost.success !== undefined) {
        const micros = Math.round(cost.success * 1_000_000)
        if (Number.isSafeInteger(micros) && micros >= 0) reportedMicroUSD = micros
        else costError = new AdapterError('invalid_response', 'Provider returned invalid reported cost')
      }
    }
    const decode = response.status < 200 || response.status >= 300
      ? Effect.fail(new AdapterError(codeForStatus(response.status, text), messageFromStatus(response.status, text, key), response.status, retryDelay(response.headers['retry-after'])))
      : costError
        ? Effect.fail(costError)
        : Result.isFailure(json)
          ? Effect.fail(json.failure)
          : Schema.decodeUnknownEffect(schema)(json.success).pipe(
            Effect.mapError(() => new AdapterError('invalid_response', 'Provider returned an invalid response')),
          )
    const result = yield* Effect.result(decode)
    return { result, ...(reportedMicroUSD === undefined ? {} : { reportedMicroUSD }) }
  })
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
