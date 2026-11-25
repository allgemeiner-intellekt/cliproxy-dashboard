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
    since: number | null
    lastRecordAt: number | null
    stored: number
    lastError: string | null
  }
  pricesLoadedAt: number | null
  tailnet: { syncedAt: number | null; error: string | null }
}

export type IdentityKind = 'key' | 'ip'

const TIMEOUT_MS = 20e3

async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
  }, TIMEOUT_MS)
  try {
    const res = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    if (!res.ok) {
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

// Rejects a response that isn't shaped like a summary, so it shows up as a load
// error with Retry instead of crashing (or blanking) the page.
export function assertUsageSummary(v: unknown): asserts v is UsageSummary {
  const ok =
    isObject(v) &&
    isObject(v.totals) &&
    typeof v.totals.costMicros === 'number' &&
    typeof v.totals.sessions === 'number' &&
    (v.bucket === 'hour' || v.bucket === 'day') &&
    typeof v.timeZone === 'string' &&
    ['providers', 'series', 'byModel', 'byMachine', 'byAccount'].every((k) => Array.isArray(v[k]))
  if (!ok) throw new Error('Unexpected response from the usage server')
}

// The viewer's time zone, so days are local days.
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export const getHealth = (signal?: AbortSignal) => api<Health>('/health', { signal })
export async function getUsage(range: Range, signal?: AbortSignal): Promise<UsageSummary> {
  const summary = await api<unknown>(`/usage?range=${range}&tz=${encodeURIComponent(timeZone())}`, { signal })
  assertUsageSummary(summary)
  return summary
}

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
  gemini: { label: 'Google', color: '#5485c4' },
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
