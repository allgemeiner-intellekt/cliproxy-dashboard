// Container HEALTHCHECK: exits 0 only if /api/health answers 200, which it
// stops doing once the collector has been disconnected for a while.
// Reads the same listener settings as the server, without requiring the rest
// of its configuration.

export {}

const host = process.env.USAGE_SERVER_HOST || '127.0.0.1'
const port = process.env.USAGE_SERVER_PORT || '5174'

// A wildcard listener is reachable on loopback; IPv6 literals need brackets.
const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
const authority = target.includes(':') ? `[${target}]:${port}` : `${target}:${port}`

try {
  const res = await fetch(`http://${authority}/api/health`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) console.error(`health: HTTP ${res.status}`)
  process.exit(res.ok ? 0 : 1)
} catch (err) {
  console.error(`health: ${(err as Error).message}`)
  process.exit(1)
}
