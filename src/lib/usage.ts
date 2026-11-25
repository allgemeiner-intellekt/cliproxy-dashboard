// Client for the usage server (server/), reached through /api.

export type Range = '24h' | '7d' | '30d' | '90d' | 'all'

export type Totals = {
  costMicros: number
  cacheSavingsMicros: number
  records: number
  unpricedRecords: number
  uncachedTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  processedTokens: number
}

export type ProviderUsage = Totals & { provider: string; sessions: number }
export type ModelUsage = Totals & { provider: string; model: string }
export type MachineUsage = Totals & {
  name: string
  nameSource: 'custom' | 'tailscale' | null
  identities: { kind: 'key' | 'ip'; value: string }[]
  models: ModelUsage[] // this machine's usage per model
}
export type AccountUsage = Totals & { name: string }

export type UsageSummary = {
  range: Range
  timeZone: string
  bucket: 'hour' | 'day'
  totals: Totals & { sessions: number }
  providers: ProviderUsage[]
  // One point per bucket: hour start (ms) or local day ("YYYY-MM-DD").
  series: {
    key: number | string
    providers: Record<string, { costMicros: number; tokens: number }>
    machines: Record<string, { costMicros: number; tokens: number }>
  }[]
  byModel: ModelUsage[]
  byMachine: MachineUsage[]
  byAccount: AccountUsage[]
}

export type Health = {
  collector: {
    connected: boolean
    authFailed?: boolean
    since: number | null
    lastRecordAt: number | null
    stored: number
    lastError: string | null
    downSince: number | null
  }
  pricesLoadedAt: number | null
  tailnet: { syncedAt: number | null; error: string | null }
}

export type BaseRates = {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

export type ModelRates = BaseRates & {
  tiers?: { aboveTokens: number; rates: BaseRates }[]
}

export type UsedModelPricing = {
  model: string
  provider: string
  pricedAs: string | null
  matchKind: 'exact' | 'fallback' | 'unpriced'
  requests: number
  unpricedRequests: number
  rates: ModelRates | null
}

export type SystemInfo = {
  collector: {
    target: string | null
    keyConfigured: boolean
    connected: boolean
    authFailed: boolean
    since: number | null
    downSince: number | null
    lastRecordAt: number | null
    stored: number
    lastError: string | null
  }
  pricing: {
    loadedAt: number | null
    cachePath: string
    totalCatalogModels: number
    usedModels: UsedModelPricing[]
  }
  storage: {
    dbPath: string
    dbSizeBytes: number
    walSizeBytes: number
    totalRequests: number
    unpricedRequests: number
    earliestAt: number | null
    latestAt: number | null
  }
  runtime: {
    listenAddress: string | null
    allowedHosts: string[]
    tailnet: { syncedAt: number | null; error: string | null }
  }
}

export type IdentityKind = 'key' | 'ip'

const TIMEOUT_MS = 20e3

export async function api<T>(path: string, options?: RequestInit & { okStatuses?: number[] }, timeoutMs = TIMEOUT_MS): Promise<T> {
  const { okStatuses, ...init } = options ?? {}
  // One controller for both the caller's cancellation and our timeout, so a hung
  // server fails the request instead of leaving the page loading forever.
  // (Not AbortSignal.any/timeout: too new for some supported Safari versions.)
  const controller = new AbortController()
  const outer = init?.signal
  const cancel = () => controller.abort()
  if (outer?.aborted) cancel()
  outer?.addEventListener('abort', cancel)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const res = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    if (!res.ok && !okStatuses?.includes(res.status)) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } catch (err) {
    if (timedOut && !outer?.aborted) throw new Error('Request timed out')
    throw err
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', cancel)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isString = (v: unknown) => typeof v === 'string'
const isArrayOf = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item)

const TOTAL_FIELDS = [
  'costMicros',
  'cacheSavingsMicros',
  'records',
  'unpricedRecords',
  'uncachedTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'outputTokens',
  'processedTokens',
] as const
const isTotals = (v: unknown): v is Record<string, unknown> =>
  isObject(v) && TOTAL_FIELDS.every((k) => typeof v[k] === 'number')

const isModel = (v: unknown) => isTotals(v) && isString(v.provider) && isString(v.model)
const isPoint = (v: unknown) => isObject(v) && typeof v.costMicros === 'number' && typeof v.tokens === 'number'
const isPointMap = (v: unknown) => isObject(v) && Object.values(v).every(isPoint)

// Rejects a response that isn't shaped like a summary, so it shows up as a load
// error with Retry instead of crashing the page. Checks every field the page
// reads, down to each row.
export function isUsageSummary(v: unknown): v is UsageSummary {
  return (
    isObject(v) &&
    isString(v.range) &&
    isString(v.timeZone) &&
    (v.bucket === 'hour' || v.bucket === 'day') &&
    isTotals(v.totals) &&
    typeof v.totals.sessions === 'number' &&
    isArrayOf(v.providers, (p) => isTotals(p) && isString(p.provider) && typeof p.sessions === 'number') &&
    isArrayOf(
      v.series,
      (b) => isObject(b) && (isString(b.key) || typeof b.key === 'number') && isPointMap(b.providers) && isPointMap(b.machines),
    ) &&
    isArrayOf(v.byModel, isModel) &&
    isArrayOf(
      v.byMachine,
      (m) =>
        isTotals(m) &&
        isString(m.name) &&
        isArrayOf(m.identities, (i) => isObject(i) && (i.kind === 'key' || i.kind === 'ip') && isString(i.value)) &&
        isArrayOf(m.models, isModel),
    ) &&
    isArrayOf(v.byAccount, (a) => isTotals(a) && isString(a.name))
  )
}

// The viewer's time zone, so days are local days.
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// Checks the fields the status pill renders.
const isHealth = (v: unknown): v is Health =>
  isObject(v) &&
  isObject(v.collector) &&
  typeof v.collector.connected === 'boolean' &&
  (v.collector.lastError === null || v.collector.lastError === undefined || isString(v.collector.lastError))

// 503 means the collector is down; the body still describes it. Anything else
// (e.g. a proxy's own 503) counts as the server being unreachable.
export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const health = await api<unknown>('/health', { signal, okStatuses: [503] })
  if (!isHealth(health)) throw new Error('Unexpected response from the usage server')
  return health
}
export async function getUsage(range: Range, signal?: AbortSignal, tz?: string): Promise<UsageSummary> {
  const zone = tz || timeZone()
  const summary = await api<unknown>(`/usage?range=${range}&tz=${encodeURIComponent(zone)}`, { signal })
  if (!isUsageSummary(summary)) throw new Error('Unexpected response from the usage server')
  return summary
}

const isSystemInfo = (v: unknown): v is SystemInfo =>
  isObject(v) &&
  isObject(v.collector) &&
  typeof v.collector.connected === 'boolean' &&
  isObject(v.pricing) &&
  Array.isArray(v.pricing.usedModels) &&
  isObject(v.storage) &&
  typeof v.storage.totalRequests === 'number' &&
  isObject(v.runtime) &&
  Array.isArray(v.runtime.allowedHosts)

export async function getSystem(signal?: AbortSignal): Promise<SystemInfo> {
  const info = await api<unknown>('/system', { signal })
  if (!isSystemInfo(info)) throw new Error('Unexpected response from the usage server')
  return info
}

export const reconnectCollector = () =>
  api<{ ok: boolean; collector?: Health['collector'] }>('/collector/reconnect', { method: 'POST', body: '{}' })

// Server allows 30 s for the LiteLLM download plus synchronous repricing of
// unpriced rows, so give the browser ample headroom before timing out.
export const refreshPricing = () =>
  api<{
    ok: boolean
    downloaded?: boolean
    repriced?: boolean
    error?: string | null
    loadedAt: number | null
    totalCatalogModels: number
  }>('/pricing/refresh', { method: 'POST', body: '{}' }, 90e3)

export const nameDevice = (kind: IdentityKind, value: string, name: string) =>
  api('/devices/name', { method: 'PUT', body: JSON.stringify({ kind, value, name }) })

export const clearDeviceName = (kind: IdentityKind, value: string) =>
  api('/devices/name', { method: 'DELETE', body: JSON.stringify({ kind, value }) })

// Local calendar day ("YYYY-MM-DD") of each series bucket.
export function bucketDay(summary: UsageSummary): (key: number | string) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: summary.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (key) => (typeof key === 'string' ? key : fmt.format(key))
}

// The series rolled up to local days; series that are already daily pass through.
export function dailySeries(summary: UsageSummary): UsageSummary['series'] {
  if (summary.bucket === 'day' || summary.range === '24h') return summary.series
  const dayOf = bucketDay(summary)
  const days = new Map<string, UsageSummary['series'][number]>()
  for (const b of summary.series) {
    const day = days.get(dayOf(b.key)) ?? { key: dayOf(b.key), providers: {}, machines: {} }
    for (const group of ['providers', 'machines'] as const) {
      for (const [name, p] of Object.entries(b[group])) {
        const sum = (day[group][name] ??= { costMicros: 0, tokens: 0 })
        sum.costMicros += p.costMicros
        sum.tokens += p.tokens
      }
    }
    days.set(day.key as string, day)
  }
  return [...days.values()]
}

// --- Providers ---------------------------------------------------------------------

// Fixed order and colors, so a provider keeps its color whatever else is shown.
const PROVIDERS: Record<string, { label: string; color: string }> = {
  openai: { label: 'OpenAI', color: 'var(--codex)' },
  anthropic: { label: 'Anthropic', color: 'var(--claude)' },
  meta: { label: 'Meta', color: 'var(--meta)' },
  xai: { label: 'xAI', color: 'var(--xai)' },
  gemini: { label: 'Google', color: 'var(--gemini)' },
  unknown: { label: 'Unknown', color: 'var(--fg-3)' },
}
const PROVIDER_ORDER = Object.keys(PROVIDERS)

export const providerLabel = (provider: string) => PROVIDERS[provider]?.label ?? provider
export const providerColor = (provider: string) => PROVIDERS[provider]?.color ?? 'var(--fg-3)'
export const byProviderOrder = (a: string, b: string) =>
  (PROVIDER_ORDER.indexOf(a) + 1 || 99) - (PROVIDER_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b)

// --- Formatting (matches T3 Code) ---------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

// $1,219.02
export const formatUsd = (micros: number) => usd.format(micros / 1e6)

// 849M, 6.04B, 19.9B: fewer decimals as the number grows.
export function formatTokens(n: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size
      const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2
      // Trim trailing zeros after the decimal point only ("6.00B" → "6B", "100M" stays).
      return `${v.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}${suffix}`
    }
  }
  return String(Math.round(n))
}

// 29.4%, <0.1%
export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.001) return '<0.1%'
  return `${(fraction * 100).toFixed(1)}%`
}

export const formatCount = (n: number) => n.toLocaleString('en-US')
