export function redirectFetch(origin: string) {
  const original = globalThis.fetch
  const redirected = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
    const headers = new Headers(request.headers)
    headers.set('x-fixture-url', request.url)
    return original(new URL('/provider', origin), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: request.signal,
    })
  }
  globalThis.fetch = Object.assign(redirected, { preconnect: original.preconnect })
  return () => { globalThis.fetch = original }
}

if (process.env.WIDEBAND_FIXTURE_ORIGIN) redirectFetch(process.env.WIDEBAND_FIXTURE_ORIGIN)
