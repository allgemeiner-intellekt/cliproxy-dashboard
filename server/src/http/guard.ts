// Request guards for the API. The dashboard has no login, so these keep other
// websites from using a visitor's browser to reach it:
//
// - Host check (DNS rebinding): a malicious page can point its own domain at
//   127.0.0.1 and then read the API as "same origin". The browser still sends
//   that domain as Host, so only known hosts are served.
// - JSON-only writes (CSRF): a cross-site form or `fetch` without a preflight
//   can only send text/plain, form or multipart bodies. Requiring
//   application/json forces a CORS preflight, which this server never grants.

import { isIP } from 'node:net'
import { hostname } from 'node:os'
import type { MiddlewareHandler } from 'hono'

// Hosts that can't be rebound by someone else:
// - IP literals: a rebinding page's Host is its domain, never an IP.
// - localhost and *.localhost: browsers resolve these to loopback themselves.
// - This machine's own name (and its mDNS name).
// - *.ts.net: Tailscale MagicDNS / `tailscale serve`; only Tailscale controls it.
// `extra` adds names (e.g. a reverse proxy's); ".example.com" also allows subdomains.
export function hostAllowed(hostHeader: string | undefined, extra: string[] = []): boolean {
  const host = hostOnly(hostHeader)
  if (!host) return false
  if (isIP(host)) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.ts.net')) return true
  if (ownNames().includes(host)) return true
  return extra.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/\.$/, '')
    return allowed.startsWith('.') ? host.endsWith(allowed) || host === allowed.slice(1) : host === allowed
  })
}

// "Example.COM.:5174" → "example.com"; "[::1]:5174" → "::1".
function hostOnly(header: string | undefined) {
  const value = header?.trim().toLowerCase()
  if (!value) return null
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(1, end) : null
  }
  return value.replace(/:\d*$/, '').replace(/\.$/, '') || null
}

function ownNames() {
  const full = hostname().toLowerCase()
  const short = full.split('.')[0]
  return [full, short, `${short}.local`]
}

export function requireKnownHost(extraHosts: string[]): MiddlewareHandler {
  return async (c, next) => {
    // Browsers always send Host; without one, fall back to the URL Bun built
    // from the listen address.
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!hostAllowed(host, extraHosts)) {
      return c.json({ error: 'Unrecognized Host header; add it to USAGE_ALLOWED_HOSTS to allow it' }, 403)
    }
    await next()
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function requireJsonWrites(): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
      if (type !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
    await next()
  }
}
