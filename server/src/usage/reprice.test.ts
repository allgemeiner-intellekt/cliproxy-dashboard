import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { PriceBook } from './pricing'
import { repriceMissing } from './reprice'

function setup(table: Record<string, unknown>) {
  const db = openDb(':memory:')
  const prices = new PriceBook(db, '/nonexistent/prices.json')
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
        row('half', { costMicros: 5, cacheSavingsMicros: null }),
        row('priced', { costMicros: 42, cacheSavingsMicros: 7, pricedAs: 'manual' }),
      ])
      .run()
    repriceMissing(db, prices)
    const byId = Object.fromEntries(db.select().from(requests).all().map((r) => [r.id, r]))
    expect(byId.unpriced).toMatchObject({ costMicros: 1_100_000, cacheSavingsMicros: 900_000, pricedAs: 'gpt-6.1-sol' })
    expect(byId.half).toMatchObject({ costMicros: 1_100_000, cacheSavingsMicros: 900_000 })
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
    ;(prices as unknown as { table: unknown }).table = TABLE
    repriceMissing(db, prices)
    expect(db.select().from(requests).get()?.costMicros).toBe(1_100_000)
  })
})
