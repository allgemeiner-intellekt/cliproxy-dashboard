// Parses and validates server configuration from environment variables.
// Kept free of side effects so it can be tested; `env.ts` applies it to
// the real environment at startup.

export type Env = {
  managementKey: string
  proxyUrl: string
  proxyHost: string
  proxyPort: number
  host: string
  port: number
  staticDir: string
  databasePath: string
  priceCachePath: string
}

// CLIProxyAPI's default port, used when CPA_TARGET doesn't name one.
const DEFAULT_PROXY_PORT = 8317

// Parses configuration from `source`, throwing one error that lists every problem.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const problems: string[] = []
  // Empty values (`USAGE_SERVER_PORT=` in .env.local) count as unset.
  const get = (name: string) => source[name]?.trim() || undefined

  const managementKey = get('CPA_MANAGEMENT_KEY')
  if (!managementKey) problems.push('CPA_MANAGEMENT_KEY is not set (add it to .env.local)')

  const proxyUrl = get('CPA_TARGET') ?? `http://127.0.0.1:${DEFAULT_PROXY_PORT}`
  const proxy = parseProxyTarget(proxyUrl, problems)

  const port = parsePort('USAGE_SERVER_PORT', get('USAGE_SERVER_PORT') ?? '5174', problems)

  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  return {
    // CLIProxyAPI management key: authenticates the usage-queue subscription.
    managementKey: managementKey!,
    proxyUrl,
    proxyHost: proxy!.host,
    proxyPort: proxy!.port,

    // Dashboard listener.
    host: get('USAGE_SERVER_HOST') ?? '127.0.0.1',
    port: port!,

    // Built dashboard (`npm run build`); served when present.
    staticDir: get('DASHBOARD_DIST') ?? 'dist',

    databasePath: get('USAGE_DB_PATH') ?? 'data/usage.db',
    priceCachePath: get('PRICE_CACHE_PATH') ?? 'data/litellm-prices.json',
  }
}

function parsePort(name: string, value: string, problems: string[]) {
  const port = /^\d+$/.test(value) ? Number(value) : NaN
  if (port >= 1 && port <= 65535) return port
  problems.push(`${name} must be a port number from 1 to 65535 (got "${value}")`)
  return undefined
}

// The collector speaks plaintext RESP to the proxy's main port, so only an
// http:// target works; https would need a TLS connection it doesn't make.
function parseProxyTarget(value: string, problems: string[]) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    problems.push(`CPA_TARGET is not a valid URL (got "${value}")`)
    return undefined
  }
  if (url.protocol !== 'http:') {
    problems.push(
      `CPA_TARGET must be an http:// URL (got "${value}"); the usage queue is read over a plaintext connection to the proxy's port`,
    )
    return undefined
  }
  if (!url.hostname) {
    problems.push(`CPA_TARGET has no host (got "${value}")`)
    return undefined
  }
  // URL drops a port equal to the scheme default (":80" reads back as ""), so
  // check the text: only a missing port falls back to CLIProxyAPI's default.
  const explicitPort = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^:/?#]*):(\d+)/i.exec(value)?.[1]
  const port = explicitPort === undefined ? DEFAULT_PROXY_PORT : parsePort('CPA_TARGET port', explicitPort, problems)
  if (port === undefined) return undefined
  // IPv6 hosts come back bracketed ("[::1]"); sockets want the bare address.
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port }
}
