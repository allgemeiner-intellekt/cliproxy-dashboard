// Container HEALTHCHECK: exits 0 only if /api/health answers 200, which it
// stops doing once the collector has been disconnected for a while.
// Reads the same listener settings as the server, without requiring the rest
// of its configuration.

import { request } from 'node:http'

// Same reading as config.ts: trimmed, empty means unset.
const env = (name: string) => process.env[name]?.trim() || undefined
const host = (env('USAGE_SERVER_HOST') ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1')
const port = Number(env('USAGE_SERVER_PORT') ?? '5174')

// A wildcard listener is reachable on loopback.
const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host

// node:http rather than fetch: it doesn't follow redirects. agent: false
// keeps the request off the global agent, which honours HTTP_PROXY when
// NODE_USE_ENV_PROXY is set. Host is localhost so the API's Host check
// accepts it whatever name the listener was configured with.
const req = request({ host: target, port, path: '/api/health', timeout: 4000, agent: false, headers: { host: 'localhost' } }, (res) => {
  res.resume()
  if (res.statusCode !== 200) console.error(`health: HTTP ${res.statusCode}`)
  process.exit(res.statusCode === 200 ? 0 : 1)
})
req.on('timeout', () => req.destroy(new Error('timed out')))
req.on('error', (err) => {
  console.error(`health: ${err.message}`)
  process.exit(1)
})
req.end()
