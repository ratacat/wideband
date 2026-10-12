import { load } from 'cheerio'

export type SerpResult = { title: string; url: string; snippet: string }
export type Serp =
  | { verdict: 'ok'; results: SerpResult[]; nextStart: number | null }
  | { verdict: 'desktop' | 'captcha' | 'enablejs' | 'unrecognized' }

const GOOGLE = 'https://www.google.com'
const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

function destination(href: string): string | null {
  if (!URL.canParse(href, GOOGLE)) return null
  const link = new URL(href, GOOGLE)
  const target = link.hostname === 'www.google.com' && link.pathname === '/url' ? link.searchParams.get('q') || link.searchParams.get('url') : link.href
  if (!target || !URL.canParse(target)) return null
  const url = new URL(target)
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) return null
  return url.href
}

export function parseSerp(html: string, pageUrl: string, start: number): Serp {
  const $ = load(html)
  const results: SerpResult[] = []
  const seen = new Set<string>()
  for (const block of $('.Gx5Zad').toArray()) {
    const anchor = $(block).find('a[href]').filter((_, element) => $(element).find('h3').length > 0).first()
    const url = destination(anchor.attr('href') ?? '')
    const title = clean(anchor.find('h3').first().text())
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet: clean($(block).children('.lQigmf').not('.sHTlR').last().text()) })
  }
  const text = clean($('body').text())
  if (!results.length) {
    if (pageUrl.includes('/sorry/') || $('#captcha-form, form[action*="sorry"]').length || /unusual traffic from your computer network/i.test(text)) return { verdict: 'captcha' }
    if (/enablejs|httpservice\/retry/.test(pageUrl) || /having trouble accessing Google Search/i.test(text)) return { verdict: 'enablejs' }
    if (!$('.Gx5Zad').length && !/did not match any documents|No results found for/i.test(text)) return { verdict: $('#rso a h3').length || / - Google Search/.test($('title').text()) ? 'desktop' : 'unrecognized' }
  }
  let nextStart: number | null = null
  for (const anchor of $('a[href]').toArray()) {
    const href = $(anchor).attr('href') ?? ''
    if (!URL.canParse(href, GOOGLE)) continue
    const link = new URL(href, GOOGLE)
    if (link.hostname !== 'www.google.com' || link.pathname !== '/search') continue
    const next = Number(link.searchParams.get('start'))
    if (Number.isSafeInteger(next) && next > start && (nextStart === null || next < nextStart)) nextStart = next
  }
  return { verdict: 'ok', results, nextStart }
}
