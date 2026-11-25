// Fills in cost and cache savings for stored requests that are missing them:
// rows from before a column existed, or models the price table has since added.

import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { requests } from '../db/schema'
import { cacheSavingsOf, costOf, type PriceBook } from './pricing'

const missing = or(isNull(requests.costMicros), isNull(requests.cacheSavingsMicros))

export function repriceMissing(db: Db, prices: PriceBook) {
  // Models first (from the partial index requests_unpriced): rows of models
  // the table still can't price are never loaded, so they cost nothing on
  // each refresh no matter how many pile up.
  const models = db
    .selectDistinct({ model: requests.model })
    .from(requests)
    .where(missing)
    .all()
    .map((r) => r.model)
    .filter((model) => prices.lookup(model) !== null)
  if (!models.length) return

  const rows = db
    .select()
    .from(requests)
    .where(and(missing, inArray(requests.model, models)))
    .all()

  let updated = 0
  db.transaction((tx) => {
    for (const row of rows) {
      const price = prices.lookup(row.model)
      if (!price) continue
      const tokens = {
        input: row.inputTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
        output: row.outputTokens,
      }
      // A stored cost is final: rows that only lack savings (from before that
      // column existed) get savings, never a recomputed cost.
      const fill =
        row.costMicros === null
          ? { costMicros: costOf(tokens, price.rates), cacheSavingsMicros: cacheSavingsOf(tokens, price.rates), pricedAs: price.pricedAs }
          : { cacheSavingsMicros: cacheSavingsOf(tokens, price.rates) }
      tx.update(requests)
        .set(fill)
        .where(eq(requests.id, row.id))
        .run()
      updated++
    }
  })
  if (updated) console.log(`[pricing] priced ${updated} stored requests`)
}
