import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'

const GOOGLE_HOSTS = /^(www\.google\.com|google\.com|consent\.google\.com|www\.gstatic\.com|ssl\.gstatic\.com):443$/

export type Relay = { url: string; bytes: () => number; close: () => Promise<void> }

export function stickyProxy(proxy: string, slot: number): URL {
  const url = new URL(proxy)
  if (url.username.endsWith('-rotate')) url.username = `${url.username.slice(0, -'-rotate'.length)}-${slot}`
  return url
}

export function openRelay(upstream: URL): Promise<Relay> {
  const auth = upstream.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')}\r\n` : ''
  const sockets = new Set<Socket>()
  let bytes = 0
  const server = createServer((_request, response) => response.writeHead(405).end())
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const target = request.url ?? ''
    if (!GOOGLE_HOSTS.test(target)) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    const remote = connect(Number(upstream.port || 80), upstream.hostname)
    sockets.add(client).add(remote)
    let pending: Buffer = Buffer.alloc(0)
    let open = false
    const close = () => {
      client.destroy()
      remote.destroy()
      sockets.delete(client)
      sockets.delete(remote)
    }
    remote.on('connect', () => {
      const hello = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`
      bytes += hello.length
      remote.write(hello)
    })
    remote.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (open) return void client.write(chunk)
      pending = Buffer.concat([pending, chunk])
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      if (pending.subarray(9, 12).toString() !== '200') {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return remote.destroy()
      }
      open = true
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (end + 4 < pending.length) client.write(pending.subarray(end + 4))
      if (head.length) {
        bytes += head.length
        remote.write(head)
      }
      client.on('data', (data: Buffer) => {
        bytes += data.length
        remote.write(data)
      })
    })
    remote.on('error', close).on('close', close)
    client.on('error', close).on('close', close)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({
      url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
      bytes: () => bytes,
      close: () => new Promise(done => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
    })
  }))
}
