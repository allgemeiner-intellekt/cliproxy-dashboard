// History import: what gets stored, what is skipped, and that importing
// twice never double counts.

import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { PriceBook } from '../usage/pricing'
import { importTranscripts, type TranscriptFile } from './importer'

function setup() {
  const db = openDb(':memory:')
  const prices = new PriceBook('/nonexistent/prices.json')
  ;(prices as unknown as { table: unknown }).table = {
    'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7 },
  }
  return { db, prices }
}

const claudeLine = (id: string, timestamp: string, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp, sessionId: 'sess', message: { id, model, usage: { input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 100 } } })

const files = (...lines: string[]): TranscriptFile[] => [{ tool: 'claude-code', lines }]

function liveRow(db: ReturnType<typeof openDb>, at: number) {
  db.insert(requests)
    .values({ id: 'live', source: 'cliproxy', occurredAt: new Date(at), receivedAt: new Date(at), provider: 'claude', model: 'claude-opus-5-5', failed: false })
    .run()
}

describe('importTranscripts', () => {
  test('stores priced rows attributed to the source machine', () => {
    const { db, prices } = setup()
    const result = importTranscripts(db, prices, files(claudeLine('m1', '2025-06-01T00:00:00Z')), '100.64.0.9')
    expect(result).toMatchObject({ imported: 1, alreadyImported: 0, afterCutoff: 0, invalidTimestamp: 0 })
    const [row] = db.select().from(requests).all()
    expect(row).toMatchObject({
      source: 'claude-code-log',
      provider: 'claude',
      tool: 'claude-code',
      clientIp: '100.64.0.9',
      sessionId: 'sess',
      inputTokens: 1000,
      cacheReadTokens: 1000,
      outputTokens: 100,
      pricedAs: 'claude-opus-5-5',
    })
    // 1000 × $5 + 1000 × $0.5 + 100 × $25 per million tokens.
    expect(row.costMicros).toBe(5000 + 500 + 2500)
    expect(row.cacheSavingsMicros).toBe(4500)
  })

  test('re-importing the same history stores nothing new', () => {
    const { db, prices } = setup()
    const input = files(claudeLine('m1', '2025-06-01T00:00:00Z'), claudeLine('m2', '2025-06-01T00:01:00Z'))
    importTranscripts(db, prices, input, '127.0.0.1')
    const again = importTranscripts(db, prices, input, '127.0.0.1')
    expect(again).toMatchObject({ imported: 0, alreadyImported: 2 })
    expect(db.select().from(requests).all()).toHaveLength(2)
  })

  test('a message repeated across lines and files is stored once', () => {
    const { db, prices } = setup()
    const line = claudeLine('m1', '2025-06-01T00:00:00Z')
    const result = importTranscripts(db, prices, [...files(line, line), ...files(line)], '127.0.0.1')
    expect(result.imported).toBe(1)
    expect(db.select().from(requests).all()).toHaveLength(1)
  })

  test('history at or after the first live record is skipped, so the two never overlap', () => {
    const { db, prices } = setup()
    const live = Date.UTC(2025, 5, 1, 12)
    liveRow(db, live)
    const result = importTranscripts(
      db,
      prices,
      files(claudeLine('before', '2025-06-01T11:59:59Z'), claudeLine('at', '2025-06-01T12:00:00Z'), claudeLine('after', '2025-06-02T00:00:00Z')),
      '127.0.0.1',
    )
    expect(result).toMatchObject({ imported: 1, afterCutoff: 2, cutoffMs: live })
  })

  test('a copy at or after the cutoff does not hide an eligible copy of the same message', () => {
    const live = Date.UTC(2025, 5, 1, 12)
    for (const order of ['late-first', 'early-first']) {
      const { db, prices } = setup()
      liveRow(db, live)
      const early = claudeLine('same', '2025-06-01T11:00:00Z')
      const late = claudeLine('same', '2025-06-01T12:00:00Z')
      const result = importTranscripts(db, prices, files(...(order === 'late-first' ? [late, early] : [early, late])), '127.0.0.1')
      expect(result).toMatchObject({ imported: 1, afterCutoff: 1 })
      const stored = db.select().from(requests).all().filter((r) => r.source === 'claude-code-log')
      expect(stored.map((r) => r.occurredAt.getTime())).toEqual([Date.UTC(2025, 5, 1, 11)])
    }
  })

  const codexLines = (events: { at: string; usage: Record<string, number>; total: Record<string, number> }[]) => [
    JSON.stringify({ type: 'session_meta', timestamp: '2025-06-01T00:00:00Z', payload: { id: 'S' } }),
    JSON.stringify({ type: 'turn_context', timestamp: '2025-06-01T00:00:00Z', payload: { model: 'gpt-6.1-sol' } }),
    ...events.map(({ at, usage, total }) =>
      JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: total } } }),
    ),
  ]

  test('a late Codex copy does not hide its eligible copy, in either file order', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const late = { at: '2025-06-01T12:00:04Z', usage, total: usage }
    const early = { at: '2025-06-01T12:00:02Z', usage, total: usage }
    for (const events of [[late, early], [early, late]]) {
      const { db, prices } = setup()
      liveRow(db, Date.UTC(2025, 5, 1, 12, 0, 3))
      const result = importTranscripts(db, prices, [{ tool: 'codex', lines: codexLines(events) }], '127.0.0.1')
      expect(result).toMatchObject({ imported: 1, afterCutoff: 1 })
      const stored = db.select().from(requests).all().filter((r) => r.source === 'codex-log')
      expect(stored.map((r) => r.occurredAt.getTime())).toEqual([Date.UTC(2025, 5, 1, 12, 0, 2)])
    }
  })

  test('same-millisecond Codex requests: a legacy import gains only the missed one, and re-import is a no-op', () => {
    const { db, prices } = setup()
    const usage = { input_tokens: 5, output_tokens: 5 }
    const at = '2025-06-01T12:00:02.123Z'
    const first = { at, usage, total: { input_tokens: 5, output_tokens: 5 } }
    const second = { at, usage, total: { input_tokens: 10, output_tokens: 10 } }
    // What the old parser stored: only the first, under the plain key.
    importTranscripts(db, prices, [{ tool: 'codex', lines: codexLines([first]) }], '127.0.0.1')
    expect(importTranscripts(db, prices, [{ tool: 'codex', lines: codexLines([first, second]) }], '127.0.0.1')).toMatchObject({ imported: 1, alreadyImported: 1 })
    expect(importTranscripts(db, prices, [{ tool: 'codex', lines: codexLines([first, second]) }], '127.0.0.1')).toMatchObject({ imported: 0, alreadyImported: 2 })
    expect(db.select().from(requests).all()).toHaveLength(2)
  })

  test('without live records the cutoff is now', () => {
    const { db, prices } = setup()
    const before = Date.now()
    const result = importTranscripts(db, prices, [], '127.0.0.1')
    expect(result.cutoffMs).toBeGreaterThanOrEqual(before)
  })

  test('unpriced models are stored with null cost, for repricing later', () => {
    const { db, prices } = setup()
    importTranscripts(db, prices, files(claudeLine('m1', '2025-06-01T00:00:00Z', 'claude-future-9')), '127.0.0.1')
    expect(db.select().from(requests).get()).toMatchObject({ costMicros: null, cacheSavingsMicros: null, pricedAs: null })
  })

  test('codex history is stored with the codex provider', () => {
    const { db, prices } = setup()
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2025-06-01T00:00:00Z', payload: { id: 'S' } }),
      JSON.stringify({ type: 'turn_context', timestamp: '2025-06-01T00:00:00Z', payload: { model: 'gpt-6.1-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2025-06-01T00:00:05Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } }),
    ]
    importTranscripts(db, prices, [{ tool: 'codex', lines }], '127.0.0.1')
    expect(db.select().from(requests).get()).toMatchObject({ source: 'codex-log', provider: 'codex', tool: 'codex', sessionId: 'S' })
  })
})
