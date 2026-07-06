#!/usr/bin/env bun
// @ts-nocheck

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type AuditSample = {
  sourceId: string
  caseId: string
  provider: string
  policy: string
  url: string
  title: string
  snippet: string
  dateClass: 'fresh' | 'stale' | 'undated'
  publishedAt: string | null
}

type Judgment = {
  label: 'A' | 'B' | 'C' | 'D' | 'F'
  useful: boolean
  reason: string
  relevant: boolean
  notes: string
}

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: bun protoblocks/src/05-freshness-truth-probe/label-audit.ts <run-dir>')
  process.exit(2)
}

function includesAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term))
}

function judge(row: AuditSample): Judgment {
  const url = row.url.toLowerCase()
  const title = row.title.toLowerCase()
  const text = `${title} ${row.snippet.toLowerCase()} ${url}`

  if (url.startsWith('/goto?')) return { label: 'F', useful: false, reason: 'broken', relevant: false, notes: 'Provider redirect URL is not a usable source URL.' }
  if (includesAny(url, ['instagram.com', 'youtube.com', 'x.com/', 'linkedin.com'])) {
    return { label: 'F', useful: false, reason: 'off_topic', relevant: false, notes: 'Social/profile/video result is not answer-bearing for this audit.' }
  }
  if (url.includes('polymarket.com') || url.includes('kalshi.com')) {
    return { label: 'D', useful: false, reason: 'polymarket_page', relevant: true, notes: 'Prediction-market page, not an official update or primary resolution source.' }
  }

  if (row.caseId === 'case-001-weather') {
    if (includesAny(url, ['nhc.noaa.gov', 'weather.gov', 'noaa.gov', 'ospo.noaa.gov', 'nwrfc.noaa.gov'])) {
      return { label: 'A', useful: true, reason: 'official_source', relevant: true, notes: 'Official NOAA/NWS weather source.' }
    }
    if (url.includes('wikipedia.org')) return { label: 'C', useful: false, reason: 'context', relevant: true, notes: 'Context page, not a current advisory.' }
    if (includesAny(text, ['2024 atlantic hurricane season', '2025 atlantic hurricane season'])) {
      return { label: 'D', useful: false, reason: 'stale', relevant: false, notes: 'Old seasonal duplicate for a latest-update query.' }
    }
    if (includesAny(url, ['wxii12.com', 'tallahassee.com', 'wctv.tv', 'cnnespanol.cnn.com', 'wokv.com', 'wyff4.com'])) {
      return { label: 'B', useful: true, reason: 'reputable_reporting', relevant: true, notes: 'Reporting directly discusses current tropical activity.' }
    }
    return { label: 'F', useful: false, reason: 'off_topic', relevant: false, notes: 'Does not directly answer the current official weather query.' }
  }

  if (row.caseId === 'case-002-sports') {
    if (url.includes('mlb.com/schedule')) return { label: 'A', useful: true, reason: 'official_source', relevant: true, notes: 'Official MLB schedule source.' }
    if (includesAny(url, ['espn.com/mlb/schedule', 'espn.co.uk/mlb/schedule', 'espn.ph/mlb/schedule', 'cbssports.com/mlb', 'baseball-reference.com', 'sportsdata.usatoday.com/baseball/mlb/schedule'])) {
      return { label: 'B', useful: true, reason: 'reputable_reporting', relevant: true, notes: 'Direct schedule or game-tracker source for the requested date.' }
    }
    if (url.includes('exa.ai/library/sports/mlb')) return { label: 'D', useful: false, reason: 'aggregator', relevant: true, notes: 'Provider-hosted sports aggregation, not a source to cite.' }
    if (url.includes('mlb.com/news/mlb-2026-schedule-released')) return { label: 'D', useful: false, reason: 'stale', relevant: true, notes: 'Schedule-release article, not today-specific game state.' }
    if (includesAny(url, ['nbc.com/nbc-insider', 'espnpressroom.com'])) return { label: 'C', useful: false, reason: 'context', relevant: true, notes: 'Broadcast context rather than direct schedule answer.' }
    return { label: 'F', useful: false, reason: 'off_topic', relevant: false, notes: 'Not a direct source for games today.' }
  }

  if (row.caseId === 'case-003-polymarket-fed') {
    if (url.includes('federalreserve.gov')) return { label: 'A', useful: true, reason: 'official_source', relevant: true, notes: 'Official Federal Reserve calendar/update source.' }
    if (includesAny(url, ['goldmansachs.com', 'cnbc.com', 'invezz.com'])) return { label: 'B', useful: true, reason: 'reputable_reporting', relevant: true, notes: 'Directly discusses current Fed cut expectations.' }
    return { label: 'F', useful: false, reason: 'off_topic', relevant: false, notes: 'Not a primary or strong evidence source for the Fed update query.' }
  }

  return { label: 'F', useful: false, reason: 'off_topic', relevant: false, notes: 'Unrecognized case.' }
}

const samples = (await readFile(join(runDir, 'audit-sample.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AuditSample)

const labels = samples.map((sample, index) => {
  const judgment = judge(sample)
  return {
    sampleId: `audit-${String(index + 1).padStart(3, '0')}`,
    sourceId: sample.sourceId,
    url: sample.url,
    label: judgment.label,
    useful: judgment.useful,
    reason: judgment.reason,
    notes: judgment.notes,
    provider: sample.provider,
    policy: sample.policy,
    caseId: sample.caseId,
    dateClass: sample.dateClass,
    relevant: judgment.relevant,
    freshnessRelevance: `${sample.dateClass}_${judgment.relevant ? 'relevant' : 'irrelevant'}`,
    publishedAt: sample.publishedAt,
  }
})

await writeFile(join(runDir, 'manual-labels.jsonl'), `${labels.map((label) => JSON.stringify(label)).join('\n')}\n`)
console.log(`wrote ${labels.length} manual labels`)
