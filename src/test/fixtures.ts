// Small, valid /api/usage payloads for frontend tests.
import type { Range, Totals, UsageSummary } from '../lib/usage'

export function totals(over: Partial<Totals> = {}): Totals {
  return {
    costMicros: 0,
    cacheSavingsMicros: 0,
    records: 0,
    unpricedRecords: 0,
    uncachedTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    processedTokens: 0,
    ...over,
  }
}

// One provider (Anthropic) with the given cost and tokens, spread over two
// daily buckets, or hourly ones for 24h.
export function summary(range: Range = '30d', costMicros = 3_000_000, tokens = 1_500_000): UsageSummary {
  const hourly = range === '24h'
  const t = totals({ costMicros, processedTokens: tokens, records: 3 })
  const point = (share: number) => ({ costMicros: costMicros * share, tokens: tokens * share })
  const keys: (string | number)[] = hourly ? [Date.UTC(2026, 10, 24, 10), Date.UTC(2026, 10, 24, 11)] : ['2026-11-23', '2026-11-24']
  return {
    range,
    timeZone: 'UTC',
    bucket: hourly ? 'hour' : 'day',
    totals: { ...t, sessions: 2 },
    providers: [{ ...t, provider: 'anthropic', sessions: 2 }],
    series: keys.map((key, i) => ({
      key,
      providers: { anthropic: point(i === 0 ? 1 / 3 : 2 / 3) },
      machines: { laptop: point(i === 0 ? 1 / 3 : 2 / 3) },
    })),
    byModel: [{ ...t, provider: 'anthropic', model: 'claude-opus' }],
    byMachine: [
      {
        ...t,
        name: 'laptop',
        nameSource: 'tailscale',
        identities: [{ kind: 'ip', value: '100.64.0.1' }],
        models: [{ ...t, provider: 'anthropic', model: 'claude-opus' }],
      },
    ],
    byAccount: [{ ...t, name: 'me@example.com' }],
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
