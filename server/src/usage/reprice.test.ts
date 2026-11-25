import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { PriceBook } from './pricing'
import { repriceMissing } from './reprice'

function setup(table: Record<string, unknown>) {
  const db = openDb(':memory:')
  const prices = new PriceBook('/nonexistent/prices.json')
  ;(prices as unknown as { table: unknown }).table = table
  return { db, prices }
}

const row = (id: string, overrides: Partial<typeof requests.$inferInsert> = {}) => ({
  id,
  source: 'cliproxy',
  occurredAt: new Date(Date.UTC(2025, 0, 1)),
  receivedAt: new Date(Date.UTC(2025, 0, 1)),
  provider: 'openai',
  model: 'gpt-6.1-sol',
  failed: false,
  inputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  outputTokens: 0,
  ...overrides,
})

const TABLE = { 'gpt-6.1-sol': { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 } }

describe('repriceMissing', () => {
  test('fills cost and savings for rows missing either, and only those', () => {
    const { db, prices } = setup(TABLE)
    db.insert(requests)
      .values([
        row('unpriced'),
        row('half', { costMicros: 5, cacheSavingsMicros: null, pricedAs: 'old-table' }),
        row('priced', { costMicros: 42, cacheSavingsMicros: 7, pricedAs: 'manual' }),
      ])
      .run()
    repriceMissing(db, prices)
    const byId = Object.fromEntries(db.select().from(requests).all().map((r) => [r.id, r]))
    expect(byId.unpriced).toMatchObject({ costMicros: 1_100_000, cacheSavingsMicros: 900_000, pricedAs: 'gpt-6.1-sol' })
    // Only savings are filled in: a stored cost (and what priced it) is final.
    expect(byId.half).toMatchObject({ costMicros: 5, cacheSavingsMicros: 900_000, pricedAs: 'old-table' })
    // Already priced rows keep their stored cost, even if rates change later.
    expect(byId.priced).toMatchObject({ costMicros: 42, cacheSavingsMicros: 7, pricedAs: 'manual' })
  })

  test('models still missing from the table stay unpriced', () => {
    const { db, prices } = setup(TABLE)
    db.insert(requests).values(row('x', { model: 'mystery' })).run()
    repriceMissing(db, prices)
    expect(db.select().from(requests).get()).toMatchObject({ costMicros: null, pricedAs: null })
  })

  test('a model added to the table later gets priced on the next pass', () => {
    const { db, prices } = setup({})
    db.insert(requests).values(row('later')).run()
    repriceMissing(db, prices)
    expect(db.select().from(requests).get()?.costMicros).toBeNull()
    ;(prices as unknown as { setTable: (t: unknown) => void }).setTable(TABLE)
    repriceMissing(db, prices)
    expect(db.select().from(requests).get()?.costMicros).toBe(1_100_000)
  })

  test('backfills provider-scoped aliases and 0-token rows', () => {
    const { db, prices } = setup({
      'moonshot/kimi-k3': { litellm_provider: 'moonshot', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'gemini/gemini-4-neon': { litellm_provider: 'gemini', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    })
    db.insert(requests)
      .values([
        row('kimi-k3', { provider: 'kimi', model: 'k3', inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 500_000 }),
        row('other-k3', { provider: 'other', model: 'k3', inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }),
        row('neon-499', { provider: 'antigravity', model: 'gemini-4-neon-xhigh', failed: true, statusCode: 499, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }),
      ])
      .run()
    repriceMissing(db, prices)
    const byId = Object.fromEntries(db.select().from(requests).all().map((r) => [r.id, r]))
    expect(byId['kimi-k3']).toMatchObject({ costMicros: 2_000_000, pricedAs: 'fallback:moonshot/kimi-k3' })
    expect(byId['other-k3']).toMatchObject({ costMicros: null, pricedAs: null })
    expect(byId['neon-499']).toMatchObject({ costMicros: 0, cacheSavingsMicros: 0, pricedAs: 'fallback:gemini/gemini-4-neon' })
  })
})

describe('repricing cost (P5)', () => {
  test('models that still have no price are looked up once, not once per row', () => {
    const { db, prices } = setup(TABLE)
    db.insert(requests).values([row('p'), ...Array.from({ length: 50 }, (_, i) => row(`u${i}`, { model: 'mystery' }))]).run()
    const asked: string[] = []
    const lookup = prices.lookup.bind(prices)
    prices.lookup = (model) => (asked.push(model), lookup(model))
    repriceMissing(db, prices)
    expect(asked.filter((m) => m === 'mystery')).toHaveLength(1)
    expect(db.select().from(requests).all().filter((r) => r.costMicros !== null).map((r) => r.id)).toEqual(['p'])
  })
})
