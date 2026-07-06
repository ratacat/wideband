import { afterEach, describe, expect, test } from 'bun:test'
import { brave } from '../src/adapters/brave'
import { desearch } from '../src/adapters/desearch'
import { exa } from '../src/adapters/exa'
import { jina } from '../src/adapters/jina'
import { linkup } from '../src/adapters/linkup'
import { nimble } from '../src/adapters/nimble'
import { parallel } from '../src/adapters/parallel'
import { getAdapter } from '../src/adapters/registry'
import { sailor } from '../src/adapters/sailor'
import { searchx } from '../src/adapters/searchx'
import { tavily } from '../src/adapters/tavily'
import type { UnifiedQuery } from '../src'

const originalFetch = globalThis.fetch

function mockJSON(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = (async (input, init) => {
    const json = handler(input.toString(), init)
    return new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('provider adapters', () => {
  test('registry includes remaining providers', () => {
    for (const name of ['tavily', 'jina', 'linkup', 'nimble', 'desearch', 'sailor', 'searchx']) {
      expect(getAdapter(name)?.name).toBe(name)
    }
  })

  test('tavily maps search filters and results', async () => {
    mockJSON((url, init) => {
      expect(url).toBe('https://api.tavily.com/search')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k')
      expect(JSON.parse(init?.body as string)).toEqual({
        query: 'ai policy',
        max_results: 3,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        topic: 'news',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        include_domains: ['example.com'],
        exclude_domains: ['spam.example'],
      })
      return {
        results: [
          {
            title: 'Policy',
            url: 'https://example.com/policy',
            content: 'Snippet',
            raw_content: 'Raw content',
            score: 0.9,
            published_date: '2026-01-02',
          },
        ],
      }
    })

    const result = await tavily.search(
      {
        q: 'ai policy',
        max: 3,
        mediaType: 'news',
        freshness: { after: '2026-01-01T05:06:07.000Z', before: '2026-01-31T23:59:59.000Z' },
        domains: { include: ['example.com'], exclude: ['spam.example'] },
      } as UnifiedQuery,
      { key: 'k', signal: new AbortController().signal },
    )

    expect(result.hits[0]).toMatchObject({
      provider: 'tavily',
      url: 'https://example.com/policy',
      snippet: 'Snippet',
      content: 'Raw content',
      publishedAt: '2026-01-02',
      score: 0.9,
      mediaType: 'news',
    })
  })

  test('brave serializes freshness as a provider date range', async () => {
    mockJSON((url) => {
      const parsed = new URL(url)
      expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search')
      expect(parsed.searchParams.get('freshness')).toBe('2026-06-12to2026-06-13')
      return { web: { results: [] } }
    })

    await brave.search(
      {
        q: 'iran usa negotiations',
        max: 2,
        mediaType: 'web',
        freshness: { after: '2026-06-12T01:28:00.000Z', before: '2026-06-13T00:00:00.000Z' },
      } as UnifiedQuery,
      { key: 'k', signal: new AbortController().signal },
    )
  })

  test('jina requests JSON SERP rows without page content', async () => {
    mockJSON((url, init) => {
      expect(url).toBe('https://s.jina.ai/')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k')
      expect((init?.headers as Record<string, string>)['X-Respond-With']).toBe('no-content')
      expect(JSON.parse(init?.body as string)).toEqual({ q: 'jina search', num: 2 })
      return {
        data: [{ title: 'Jina', description: 'Search foundation', url: 'https://jina.ai/' }],
      }
    })

    const result = await jina.search({ q: 'jina search', max: 2, mediaType: 'web' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(result.hits[0]).toMatchObject({
      provider: 'jina',
      title: 'Jina',
      snippet: 'Search foundation',
      url: 'https://jina.ai/',
      mediaType: 'web',
    })
  })

  test('linkup uses fast search results and filters image mode', async () => {
    mockJSON((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({
        q: 'barack obama',
        depth: 'fast',
        outputType: 'searchResults',
        maxResults: 5,
        includeImages: true,
        fromDate: '2026-03-01',
        toDate: '2026-03-02',
      })
      return {
        results: [
          { type: 'text', name: 'Bio', url: 'https://example.com/bio', content: 'Text result' },
          { type: 'image', name: 'Portrait', url: 'https://example.com/image.jpg' },
        ],
      }
    })

    const result = await linkup.search(
      {
        q: 'barack obama',
        max: 5,
        mediaType: 'image',
        freshness: { after: '2026-03-01T10:00:00.000Z', before: '2026-03-02T10:00:00.000Z' },
      } as UnifiedQuery,
      {
        key: 'k',
        signal: new AbortController().signal,
      },
    )

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      provider: 'linkup',
      title: 'Portrait',
      url: 'https://example.com/image.jpg',
      mediaType: 'image',
    })
  })

  test('linkup sends a valid date range when freshness only has after', async () => {
    mockJSON((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({
        fromDate: '2026-06-12',
        toDate: '2026-06-13',
      })
      return { results: [] }
    })

    await linkup.search(
      {
        q: 'recent articles',
        max: 3,
        mediaType: 'web',
        freshness: { after: '2026-06-12T01:28:00.000Z' },
      } as UnifiedQuery,
      { key: 'k', signal: new AbortController().signal },
    )
  })

  test('nimble maps SERP payload and metadata', async () => {
    mockJSON((url, init) => {
      expect(url).toBe('https://sdk.nimbleway.com/v1/serp')
      expect(JSON.parse(init?.body as string)).toMatchObject({
        search_engine: 'google_news',
        query: 'earnings (site:example.com)',
        num_results: 4,
        country: 'US',
        locale: 'en',
        no_html: true,
      })
      return {
        data: {
          parsing: {
            entities: {
              OrganicResult: [
                {
                  title: 'Earnings',
                  snippet: 'Quarterly results',
                  url: 'https://example.com/earnings',
                  position: 2,
                  date: '2026-02-03',
                  source: 'Analyst',
                },
              ],
            },
          },
        },
      }
    })

    const result = await nimble.search(
      {
        q: 'earnings',
        max: 4,
        mediaType: 'news',
        freshness: { after: '2026-02-01T08:00:00.000Z', before: '2026-02-05T08:00:00.000Z' },
        domains: { include: ['example.com'] },
      } as UnifiedQuery,
      { key: 'k', signal: new AbortController().signal },
    )

    expect(result.hits[0]).toMatchObject({
      provider: 'nimble',
      title: 'Earnings',
      snippet: 'Quarterly results',
      url: 'https://example.com/earnings',
      publishedAt: '2026-02-03',
      author: 'Analyst',
      rank: 2,
      mediaType: 'news',
    })
  })

  test('nimble uses SERP for research mode instead of hanging AI search', async () => {
    mockJSON((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({
        search_engine: 'google_search',
        query: 'deep research',
        no_html: true,
      })
      return { data: { parsing: { entities: { OrganicResult: [] } } } }
    })

    await nimble.search({ q: 'deep research', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
  })

  test('desearch uses raw authorization header and SERP data', async () => {
    mockJSON((url, init) => {
      const parsed = new URL(url)
      expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.desearch.ai/web')
      expect(parsed.searchParams.get('query')).toBe('agent search')
      expect(parsed.searchParams.get('num')).toBe('6')
      expect((init?.headers as Record<string, string>).authorization).toBe('k')
      return {
        data: [{ title: 'Agent Search', snippet: 'Result snippet', link: 'https://example.com/search', date: '2026-03-01' }],
      }
    })

    const result = await desearch.search({ q: 'agent search', max: 6, mediaType: 'web' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(result.hits[0]).toMatchObject({
      provider: 'desearch',
      title: 'Agent Search',
      snippet: 'Result snippet',
      url: 'https://example.com/search',
      publishedAt: '2026-03-01',
      mediaType: 'web',
    })
  })

  test('sailor requests markdown search rows', async () => {
    mockJSON((url, init) => {
      expect(url).toBe('https://sailorsearch.dev/api/v1/search')
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k')
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('k')
      expect(JSON.parse(init?.body as string)).toEqual({
        q: 'agent memory',
        num: 4,
        format: 'markdown',
        engine: 'sail',
        search_mode: 'basic',
        dedupe: true,
      })
      return {
        results: [
          {
            title: 'Agent Memory',
            url: 'https://example.com/memory',
            markdown: '# Agent Memory\nLong markdown content',
            published_at: '2026-04-01',
            score: 0.7,
          },
        ],
      }
    })

    const result = await sailor.search({ q: 'agent memory', max: 4, mediaType: 'web' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(result.hits[0]).toMatchObject({
      provider: 'sailor',
      title: 'Agent Memory',
      snippet: '# Agent Memory\nLong markdown content',
      url: 'https://example.com/memory',
      publishedAt: '2026-04-01',
      score: 0.7,
      mediaType: 'web',
    })
    expect(result.hits[0]?.content).toBeUndefined()
  })

  test('searchx maps keyword web search and image search', async () => {
    const urls: string[] = []
    mockJSON((url, init) => {
      urls.push(url)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k')
      const parsed = new URL(url)
      expect(parsed.searchParams.get('q')).toBe('vector db')
      expect(parsed.searchParams.get('per_page')).toBe('3')

      if (parsed.pathname === '/api/v1/images/search') {
        return {
          results: [{ title: 'Diagram', image_url: 'https://example.com/image.png', alt: 'Vector diagram' }],
        }
      }

      expect(`${parsed.origin}${parsed.pathname}`).toBe('https://searchx.dev/api/v1/search')
      expect(parsed.searchParams.get('mode')).toBe('keyword')
      return {
        results: [
          {
            title: 'Vector DB',
            url: 'https://example.com/vector',
            snippet: 'Vector <span class="searchmatch">database</span> overview',
            score: 12.5,
            citation: 'Vector DB - example.com',
          },
        ],
      }
    })

    const web = await searchx.search({ q: 'vector db', max: 3, mediaType: 'web' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
    const image = await searchx.search({ q: 'vector db', max: 3, mediaType: 'image' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(urls.map((url) => new URL(url).pathname)).toEqual(['/api/v1/search', '/api/v1/images/search'])
    expect(web.hits[0]).toMatchObject({
      provider: 'searchx',
      title: 'Vector DB',
      snippet: 'Vector database overview',
      url: 'https://example.com/vector',
      score: 12.5,
      mediaType: 'web',
    })
    expect(image.hits[0]).toMatchObject({
      provider: 'searchx',
      title: 'Diagram',
      url: 'https://example.com/image.png',
      mediaType: 'image',
    })
  })

  test('sailor and searchx use heavier research settings', async () => {
    const bodies: unknown[] = []
    const urls: string[] = []
    mockJSON((url, init) => {
      urls.push(url)
      if (init?.body) bodies.push(JSON.parse(init.body as string))
      if (url === 'https://sailorsearch.dev/api/v1/search') {
        return { results: [{ title: 'Sailor', url: 'https://example.com/sailor', snippet: 'Sailor snippet' }] }
      }
      return { results: [{ title: 'SearchX', url: 'https://example.com/searchx', content: 'SearchX content' }] }
    })

    const sailorResult = await sailor.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
    const searchxResult = await searchx.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(bodies[0]).toEqual({
      q: 'research topic',
      num: 2,
      format: 'markdown',
      engine: 'sail',
      search_mode: 'advanced',
      dedupe: true,
    })
    expect(new URL(urls[1]!).searchParams.get('mode')).toBe('hybrid')
    expect(sailorResult.hits[0]?.snippet).toBe('Sailor snippet')
    expect(searchxResult.hits[0]?.content).toBe('SearchX content')
  })

  test('research mode asks rich-content providers for heavier retrieval', async () => {
    const bodies: unknown[] = []
    mockJSON((url, init) => {
      bodies.push(JSON.parse(init?.body as string))
      if (url === 'https://api.exa.ai/search') {
        return { results: [{ title: 'Exa', url: 'https://example.com/exa', text: 'Full exa text', highlights: ['Exa highlight'] }] }
      }
      if (url === 'https://api.parallel.ai/v1/search') {
        return { results: [{ title: 'Parallel', url: 'https://example.com/parallel', excerpts: ['Parallel excerpt'] }] }
      }
      if (url === 'https://api.tavily.com/search') {
        return { results: [{ title: 'Tavily', url: 'https://example.com/tavily', content: 'Tavily snippet', raw_content: 'Tavily raw' }] }
      }
      return { data: [{ title: 'Jina', url: 'https://example.com/jina', description: 'Jina description', content: 'Jina content' }] }
    })

    await exa.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
    await parallel.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
    await tavily.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })
    const jinaResult = await jina.search({ q: 'research topic', max: 2, mediaType: 'web', mode: 'research' } as UnifiedQuery, {
      key: 'k',
      signal: new AbortController().signal,
    })

    expect(bodies[0]).toMatchObject({ type: 'auto', contents: { highlights: true, text: { maxCharacters: 6000 } } })
    expect(bodies[1]).toMatchObject({ mode: 'advanced', advanced_settings: { max_results: 2 } })
    expect(bodies[2]).toMatchObject({ search_depth: 'advanced', include_raw_content: 'markdown', chunks_per_source: 3 })
    expect(bodies[3]).toEqual({ q: 'research topic', num: 2 })
    expect(jinaResult.hits[0]?.content).toBe('Jina content')
  })
})
