import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { usageSummary } from './summary'

const now = Date.UTC(2026, 9, 14, 12, 30)

function fixture(rows: Partial<typeof requests.$inferInsert>[]) {
  const db = openDb(':memory:')
  db.insert(requests).values(rows.map((row, i) => ({
    id: String(i), source: 'cliproxy', occurredAt: new Date(now - 1000),
    receivedAt: new Date(now), provider: 'codex', model: 'gpt-6.1-sol',
    tool: 'claude-code', sessionId: 'session', failed: false,
    inputTokens: 100, cacheReadTokens: 200, outputTokens: 10,
    costMicros: 1000, cacheSavingsMicros: 500, ...row,
  }))).run()
  return db
}

describe('usage provider attribution', () => {
  test('merges the served model across harnesses in every breakdown', () => {
    const db = fixture([
      { provider: 'codex', tool: 'claude-code' },
      { provider: 'openai', tool: 'OpenAI', sessionId: 'sdk' },
      { provider: 'codex', tool: 'T3', sessionId: 'chat' },
      // Historical imports incorrectly inherited their provider from the client.
      { source: 'claude-code-log', provider: 'claude', sessionId: 'history' },
      { model: 'claude-opus-5-5', provider: 'openai' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    const openai = summary.providers.find((p) => p.provider === 'openai')!
    expect(summary.providers.map((p) => p.provider).sort()).toEqual(['anthropic', 'openai'])
    expect(openai.costMicros).toBe(4000)
    expect(openai.processedTokens).toBe(1240)
    expect(openai.sessions).toBe(4)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byModel[0]).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', records: 4 })
    expect(summary.byMachine[0].models).toHaveLength(2)
    expect(summary.series.at(-1)?.providers.openai).toEqual({ costMicros: 4000, tokens: 1240 })
    expect(summary.totals).toMatchObject({ costMicros: 5000, cacheSavingsMicros: 2500, records: 5, sessions: 4 })
    // Preserve provenance and upstream routing information in storage.
    expect(db.select().from(requests).all()[3]).toMatchObject({ tool: 'claude-code', provider: 'claude' })
  })

  test('recognizes namespaced models and uses upstream only for opaque names', () => {
    const db = fixture([
      { model: ' OpenAI/GPT-6.1-SOL ', provider: 'claude' },
      { model: 'anthropic/claude-opus-5-5', provider: 'codex' },
      { model: 'o3-mini', provider: 'claude' },
      { model: 'gemini-2.5-pro', provider: 'openai' },
      { model: 'opaque-alias', provider: 'codex' },
      { model: 'opaque-alias', provider: 'T3', tool: 'T3' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.providers.map((p) => [p.provider, p.records]).sort()).toEqual([
      ['anthropic', 1], ['gemini', 1], ['openai', 3], ['unknown', 1],
    ])
  })

  test('counts a failover session once overall and scopes ids to their client', () => {
    const db = fixture([
      {},
      { model: 'claude-opus-5-5', provider: 'claude' },
      { tool: 'codex' }, // same session string, different client
      { sessionId: null },
      { occurredAt: new Date(now - 48 * 3600e3), sessionId: 'old' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.totals.sessions).toBe(2)
    expect(summary.providers.find((p) => p.provider === 'openai')?.sessions).toBe(2)
    expect(summary.providers.find((p) => p.provider === 'anthropic')?.sessions).toBe(1)
    expect(summary.totals.records).toBe(4)
  })

  test('maps grok-* models to xai vendor', () => {
    const db = fixture([
      { model: 'xai/grok-4.3', provider: 'codex' },
      { model: 'grok-4-fast', provider: 'claude' },
      { model: 'grok-beta', provider: 'openai' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.providers.map((p) => [p.provider, p.records]).sort()).toEqual([['xai', 3]])
    // All three grok-* models are attributed to xai; exact order depends on stable sort of equal-cost rows.
    expect(summary.byModel).toHaveLength(3)
    expect(summary.byModel.every((m) => m.provider === 'xai')).toBe(true)
    const models = summary.byModel.map((m) => m.model).sort()
    expect(models).toEqual(['grok-4-fast', 'grok-beta', 'xai/grok-4.3'])
  })
})

describe('usage windows', () => {
  test('buckets the week by hour from local midnight six days ago', () => {
    const db = fixture([
      { occurredAt: new Date(Date.UTC(2026, 9, 8, 5, 59)) },
      { occurredAt: new Date(Date.UTC(2026, 9, 8, 6, 5)) },
      { occurredAt: new Date(Date.UTC(2026, 9, 14, 9, 15)) },
      { occurredAt: new Date(Date.UTC(2026, 9, 14, 9, 45)) },
    ])
    const summary = usageSummary(db, '7d', 'America/Denver', now)
    expect(summary.bucket).toBe('hour')
    expect(summary.series[0].key).toBe(Date.UTC(2026, 9, 8, 6))
    expect(summary.series.at(-1)?.key).toBe(Date.UTC(2026, 9, 14, 12))
    expect(summary.series).toHaveLength(6 * 24 + 7)
    expect(summary.totals.records).toBe(3)
    expect(summary.series.find((b) => b.key === Date.UTC(2026, 9, 14, 9))?.providers.openai?.costMicros).toBe(2000)
  })
})

describe('all-time window bounds (D5)', () => {
  test('an ancient row does not stretch the window back centuries', () => {
    const db = fixture([{ occurredAt: new Date(Date.UTC(1000, 0, 1)) }, {}])
    const started = performance.now()
    const summary = usageSummary(db, 'all', 'UTC', now)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(summary.series[0].key).toBe('2020-01-01')
    expect(summary.series.at(-1)?.key).toBe('2026-10-14')
  })

  test('days stay in order and contiguous', () => {
    const db = fixture([{ occurredAt: new Date(Date.UTC(2026, 8, 28)) }])
    const keys = usageSummary(db, 'all', 'UTC', now).series.map((s) => s.key)
    const expected = Array.from({ length: 17 }, (_, i) => new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10))
    expect(keys).toEqual(expected)
  })
})

describe('time zones whose offset is not whole hours (D6)', () => {
  // 2026-10-14 in India (+05:30) runs 2026-10-13T18:30Z to 2026-10-14T18:30Z.
  const ist = (h: number, m: number) => new Date(Date.UTC(2026, 9, 13, 18, 30) + (h * 60 + m) * 60e3)

  test('requests just after local midnight land on the right local day', () => {
    const db = fixture([{ occurredAt: ist(0, 10) }, { occurredAt: ist(-1, 50) }])
    const days = usageSummary(db, '30d', 'Asia/Kolkata', now).series
    const day = (key: string) => days.find((d) => d.key === key)?.providers.openai?.costMicros ?? 0
    expect(day('2026-10-14')).toBe(1000) // 00:10 local
    expect(day('2026-10-13')).toBe(1000) // 23:50 local the day before
  })

  test("the window includes its first day's first half hour", () => {
    // 30d ending 2026-10-14 starts on 2026-09-15 at local midnight = 18:30Z the day before.
    const startOfFirstDay = new Date(Date.UTC(2026, 8, 14, 18, 30))
    const db = fixture([{ occurredAt: new Date(startOfFirstDay.getTime() + 10 * 60e3) }])
    const summary = usageSummary(db, '30d', 'Asia/Kolkata', now)
    expect(summary.totals.records).toBe(1)
    expect(summary.series[0]).toMatchObject({ key: '2026-09-15', providers: { openai: { costMicros: 1000 } } })
  })

  test('hourly buckets follow local hours (+05:45)', () => {
    const at = Date.UTC(2026, 9, 14, 11, 50) // 17:35 in Kathmandu
    const db = fixture([{ occurredAt: new Date(at) }])
    const summary = usageSummary(db, '24h', 'Asia/Kathmandu', now)
    const hit = summary.series.find((s) => s.providers.openai)
    // The bucket starts at 17:00 local = 11:15Z.
    expect(hit?.key).toBe(Date.UTC(2026, 9, 14, 11, 15))
    expect(summary.series).toHaveLength(24)
    expect(summary.totals.records).toBe(1)
  })
})

describe('summary cache (P4)', () => {
  test('repeats are served from cache until data changes', () => {
    const db = fixture([{}])
    const first = usageSummary(db, '24h', 'UTC', now)
    expect(usageSummary(db, '24h', 'UTC', now)).toBe(first)
    db.insert(requests).values({ id: 'new', source: 'cliproxy', occurredAt: new Date(now - 5000), receivedAt: new Date(now), provider: 'codex', model: 'gpt-6.1-sol', failed: false, costMicros: 1 }).run()
    const second = usageSummary(db, '24h', 'UTC', now)
    expect(second).not.toBe(first)
    expect(second.totals.records).toBe(2)
  })

  test('different databases never share entries', () => {
    const a = fixture([{}])
    const b = fixture([{}, {}])
    expect(usageSummary(a, '24h', 'UTC', now).totals.records).toBe(1)
    expect(usageSummary(b, '24h', 'UTC', now).totals.records).toBe(2)
  })

  test('a new window (time moving on) is recomputed', () => {
    const db = fixture([{}])
    const first = usageSummary(db, '24h', 'UTC', now)
    expect(usageSummary(db, '24h', 'UTC', now + 2 * 3600e3)).not.toBe(first)
  })
})

describe('fractional DST changes (Lord Howe, +10:30 ↔ +11:00)', () => {
  test("a 7d window across the change starts at the first day's local midnight", () => {
    // DST began 2026-10-04 02:00 local (+10:30 → +11:00).
    const now = Date.UTC(2026, 9, 6, 1) // 2026-10-06 12:00 local (+11:00)
    // 7d starts 2026-09-30 00:00 local (+10:30) = 2026-09-29T13:30Z.
    const start = Date.UTC(2026, 8, 29, 13, 30)
    const db = fixture([
      { id: 'before', occurredAt: new Date(start - 10 * 60e3) }, // 23:50 local the day before
      { id: 'first', occurredAt: new Date(start + 10 * 60e3) },
      { id: 'after', occurredAt: new Date(Date.UTC(2026, 9, 5, 2, 10)) }, // after the change
    ])
    const summary = usageSummary(db, '7d', 'Australia/Lord_Howe', now)
    expect(summary.totals.records).toBe(2)
    expect(summary.series[0].key).toBe(start)
    // Buckets before the change start at :30 UTC, after it on the hour.
    expect(new Date(summary.series[0].key as number).getUTCMinutes()).toBe(30)
    expect(new Date(summary.series.at(-1)!.key as number).getUTCMinutes()).toBe(0)
    expect(summary.series.reduce((n, s) => n + (s.providers.openai ? 1 : 0), 0)).toBe(2)
  })
})
