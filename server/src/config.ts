// Parses and validates configuration from environment variables. Kept free
// of side effects so it can be tested; `env.ts` applies it to the real
// environment at startup.

type Source = Record<string, string | undefined>

// What every entry point needs: where data lives.
export type StorageEnv = {
  databasePath: string
  priceCachePath: string
  priceAliasesPath?: string
}

// The server additionally talks to the proxy and listens for the dashboard.
export type ServerEnv = StorageEnv & {
  managementKey: string
  proxyHost: string
  proxyPort: number
  host: string
  port: number
  allowedHosts: string[]
  staticDir: string
}

// CLIProxyAPI's default port, used when CPA_TARGET doesn't name one.
const DEFAULT_PROXY_PORT = 8317

// Empty values (`USAGE_SERVER_PORT=` in .env.local) count as unset.
const getter = (source: Source) => (name: string) => source[name]?.trim() || undefined

// Configuration problems, reported together.
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function parseStorageEnv(source: Source): StorageEnv {
  const get = getter(source)
  return {
    databasePath: get('USAGE_DB_PATH') ?? 'data/usage.db',
    priceCachePath: get('PRICE_CACHE_PATH') ?? 'data/litellm-prices.json',
    priceAliasesPath: get('PRICE_ALIASES_PATH'),
  }
}

// Parses the server's configuration, throwing a ConfigError that lists every problem.
export function parseServerEnv(source: Source): ServerEnv {
  const problems: string[] = []
  const get = getter(source)

  // A password: used byte for byte, never trimmed.
  const managementKey = source.CPA_MANAGEMENT_KEY
  if (!managementKey?.trim()) problems.push('CPA_MANAGEMENT_KEY is not set (add it to .env.local)')

  const proxy = parseProxyTarget(get('CPA_TARGET') ?? `http://127.0.0.1:${DEFAULT_PROXY_PORT}`, problems)
  const port = parsePort('USAGE_SERVER_PORT', get('USAGE_SERVER_PORT') ?? '5174', problems)

  if (problems.length || !managementKey || !proxy || port === undefined) throw new ConfigError(problems)
  return {
    ...parseStorageEnv(source),
    // CLIProxyAPI management key: authenticates the usage-queue subscription.
    managementKey,
    proxyHost: proxy.host,
    proxyPort: proxy.port,

    // Dashboard listener.
    host: get('USAGE_SERVER_HOST') ?? '127.0.0.1',
    port,
    // Extra Host names the API answers to (reverse proxies); see http/guard.ts.
    allowedHosts: (get('USAGE_ALLOWED_HOSTS') ?? '').split(',').map((h) => h.trim()).filter(Boolean),

    // Built dashboard (`npm run build`); served when present.
    staticDir: get('DASHBOARD_DIST') ?? 'dist',
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
// Messages never echo the URL: it may carry credentials.
function parseProxyTarget(value: string, problems: string[]) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    problems.push('CPA_TARGET is not a valid URL')
    return undefined
  }
  if (url.protocol !== 'http:') {
    problems.push(
      `CPA_TARGET must be an http:// URL (got ${url.protocol}//); the usage queue is read over a plaintext connection to the proxy's port`,
    )
    return undefined
  }
  if (!url.hostname) {
    problems.push('CPA_TARGET has no host')
    return undefined
  }
  // URL reads ":80" back as "" (the http default), so only a port that is
  // really absent falls back to CLIProxyAPI's default.
  const port = url.port ? Number(url.port) : hasExplicitPort(value) ? 80 : DEFAULT_PROXY_PORT
  if (port < 1) {
    problems.push('CPA_TARGET port must be from 1 to 65535')
    return undefined
  }
  // IPv6 hosts come back bracketed ("[::1]"); sockets want the bare address.
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port }
}

// Whether the URL's authority ends in ":<digits>". Only consulted when URL
// reports no port, so it tells an explicit default port from a missing one.
function hasExplicitPort(value: string) {
  // Like URL: ignore tabs and newlines, accept any run of slashes after the scheme.
  const rest = value.replace(/[\t\n\r]/g, '').replace(/^[a-z][a-z0-9+.-]*:[/\\]*/i, '')
  const authority = rest.split(/[/?#\\]/)[0]
  return /:\d+$/.test(authority.slice(authority.lastIndexOf('@') + 1))
}
