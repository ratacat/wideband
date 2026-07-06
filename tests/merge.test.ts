import { describe, expect, test } from 'bun:test'
import { canonicalizeUrl, mergeHits } from '../src/core/merge'
import type { Hit } from '../src/core/types'

describe('canonicalizeUrl', () => {
  test('normalizes scheme, host, fragments, tracking params, slash, and param order', () => {
    expect(canonicalizeUrl('http://www.Example.com:80/path/?b=2&utm_source=x&a=1#frag')).toBe(
      'https://example.com/path?a=1&b=2',
    )
    expect(canonicalizeUrl('https://www.EXAMPLE.com:443/a/#x')).toBe('https://example.com/a')
    expect(canonicalizeUrl('https://example.com/?ref=abc&z=1')).toBe('https://example.com/?z=1')
  })
})

describe('mergeHits', () => {
  test('dedupes URLs, preserves provenance, and keeps best metadata', () => {
    const hits: Hit[] = [
      {
        provider: 'exa',
        rank: 10,
        url: 'https://example.com/post?utm_campaign=x',
        title: 'Short',
        snippet: 'small',
        content: 'short content',
        publishedAt: '2025-01-02',
        mediaType: 'web',
      },
      {
        provider: 'brave',
        rank: 8,
        url: 'http://www.example.com/post',
        title: 'Longer title',
        snippet: 'a much longer useful snippet',
        content: 'a much longer content body',
        publishedAt: '2024-12-31',
        mediaType: 'web',
      },
    ]

    const [source] = mergeHits(hits)
    expect(source).toBeDefined()
    expect(source!.url).toBe('https://example.com/post')
    expect(source!.providers).toEqual(['exa', 'brave'])
    expect(source!.provenance).toEqual([
      { provider: 'exa', rank: 10 },
      { provider: 'brave', rank: 8 },
    ])
    expect(source!.title).toBe('Longer title')
    expect(source!.snippet).toBe('a much longer useful snippet')
    expect(source!.content).toBe('a much longer content body')
    expect(source!.publishedAt).toBe('2024-12-31')
    expect(source!.uniqueTo).toBeUndefined()
  })

  test('RRF ranks multi-provider sources over a one-provider rank-1 source and marks uniqueTo', () => {
    const sources = mergeHits([
      { provider: 'exa', rank: 1, url: 'https://only.example/a', title: 'Only', mediaType: 'web' },
      { provider: 'brave', rank: 10, url: 'https://shared.example/a', title: 'Shared', mediaType: 'web' },
      { provider: 'parallel', rank: 10, url: 'https://www.shared.example/a?utm_source=x', title: 'Shared', mediaType: 'web' },
    ])

    expect(sources[0]!.url).toBe('https://shared.example/a')
    expect(sources[0]!.uniqueTo).toBeUndefined()
    expect(sources[1]!.url).toBe('https://only.example/a')
    expect(sources[1]!.uniqueTo).toBe('exa')
  })

  test('merges freshness labels by provider and keeps the strongest confidence', () => {
    const [source] = mergeHits([
      { provider: 'exa', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web', freshness: { confidence: 'verified' } },
      { provider: 'brave', rank: 2, url: 'https://www.example.com/a', title: 'A', mediaType: 'web', freshness: { confidence: 'native' } },
    ])

    expect(source?.freshness).toEqual({
      confidence: 'native',
      providers: {
        exa: 'verified',
        brave: 'native',
      },
    })
  })
})
