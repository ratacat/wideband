type Freshness = { after?: string; before?: string } | undefined
export type FreshnessClassification = 'unscoped' | 'within' | 'stale' | 'undated'

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function dateOnly(value: string): string {
  const prefixed = DATE_PREFIX.exec(value)?.[1]
  if (prefixed) return prefixed
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toISOString().slice(0, 10)
}

export function addDays(value: string, days: number): string {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return value
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function time(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function withinFreshness(publishedAt: string | undefined, freshness: Freshness): boolean {
  return classifyFreshness(publishedAt, freshness) !== 'stale'
}

export function classifyFreshness(publishedAt: string | undefined, freshness: Freshness): FreshnessClassification {
  if (!freshness) return 'unscoped'
  if (!publishedAt) return 'undated'

  const publishedTime = time(publishedAt)
  if (publishedTime === undefined) return 'undated'

  const publishedDateOnly = DATE_ONLY.test(publishedAt)
  if (freshness.after) {
    const afterTime = time(freshness.after)
    const sameDateOnly = publishedDateOnly && publishedAt === dateOnly(freshness.after)
    if (afterTime !== undefined && publishedTime < afterTime && !sameDateOnly) return 'stale'
  }

  if (freshness.before) {
    const beforeTime = time(freshness.before)
    const sameDateOnly = publishedDateOnly && publishedAt === dateOnly(freshness.before)
    if (beforeTime !== undefined && publishedTime > beforeTime && !sameDateOnly) return 'stale'
  }

  return 'within'
}
