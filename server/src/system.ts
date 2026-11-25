// System transparency snapshot: collector status, effective pricing for used
// models, storage stats, and read-only runtime configuration.

import { statSync } from 'node:fs'
import { asc, desc, sql } from 'drizzle-orm'
import type { CliproxyCollector, CollectorStatus } from './collector/cliproxy'
import type { Db } from './db/client'
import { requests, usageRollup } from './db/schema'
import type { Tailnet } from './tailnet'
import type { PriceBook, Rates } from './usage/pricing'

export type RuntimeMetadata = {
  dbPath?: string
  listenAddress?: string
  allowedHosts?: string[]
}

export type UsedModelPricing = {
  model: string
  provider: string
  pricedAs: string | null
  matchKind: 'exact' | 'fallback' | 'unpriced'
  requests: number
  unpricedRequests: number
  rates: Rates | null
}

export type SystemInfo = {
  collector: CollectorStatus & {
    target: string | null
    keyConfigured: boolean
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
    tailnet: {
      syncedAt: number | null
      error: string | null
    }
  }
}

function fileSize(path: string | undefined): number {
  if (!path || path === ':memory:') return 0
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function systemInfo(
  db: Db,
  collector: CliproxyCollector,
  prices: PriceBook,
  tailnet: Tailnet,
  runtime: RuntimeMetadata = {},
): SystemInfo {
  // Read rollup totals and request date bounds in one transaction so they
  // observe a single consistent SQLite snapshot.
  const { modelRows, earliest, latest } = db.transaction((tx) => {
    const rows = tx
      .select({
        model: usageRollup.model,
        provider: usageRollup.provider,
        requests: sql<number>`coalesce(sum(${usageRollup.records}), 0)`,
        unpricedRequests: sql<number>`coalesce(sum(${usageRollup.unpricedRecords}), 0)`,
      })
      .from(usageRollup)
      .groupBy(usageRollup.provider, usageRollup.model)
      .orderBy(desc(sql`coalesce(sum(${usageRollup.records}), 0)`), usageRollup.model)
      .all()

    // Two single-row index seeks on requests_occurred_at avoid a full index scan.
    const first = tx
      .select({ occurredAt: requests.occurredAt })
      .from(requests)
      .orderBy(asc(requests.occurredAt))
      .limit(1)
      .get()
    const last = tx
      .select({ occurredAt: requests.occurredAt })
      .from(requests)
      .orderBy(desc(requests.occurredAt))
      .limit(1)
      .get()

    return { modelRows: rows, earliest: first, latest: last }
  })

  const usedModels: UsedModelPricing[] = modelRows.map((row) => {
    const priced = prices.lookup(row.model)
    const matchKind = !priced ? 'unpriced' : priced.pricedAs.startsWith('fallback:') ? 'fallback' : 'exact'
    return {
      model: row.model,
      provider: row.provider,
      pricedAs: priced?.pricedAs ?? null,
      matchKind,
      requests: row.requests,
      unpricedRequests: row.unpricedRequests,
      rates: priced?.rates ?? null,
    }
  })

  let totalRequests = 0
  let unpricedRequests = 0
  for (const row of modelRows) {
    totalRequests += row.requests
    unpricedRequests += row.unpricedRequests
  }

  const dbPath = runtime.dbPath ?? ':memory:'
  const builtInHosts = ['localhost', '127.0.0.1', '*.ts.net']
  const configuredHosts = runtime.allowedHosts ?? []

  return {
    collector: {
      ...collector.status,
      authFailed: Boolean(collector.status.authFailed),
      target: typeof collector.target === 'string' ? collector.target : null,
      keyConfigured: Boolean(collector.keyConfigured),
    },
    pricing: {
      loadedAt: prices.loadedAt,
      cachePath: prices.path,
      totalCatalogModels: prices.modelCount,
      usedModels,
    },
    storage: {
      dbPath,
      dbSizeBytes: fileSize(dbPath),
      walSizeBytes: dbPath === ':memory:' ? 0 : fileSize(`${dbPath}-wal`),
      totalRequests,
      unpricedRequests,
      earliestAt: earliest ? earliest.occurredAt.getTime() : null,
      latestAt: latest ? latest.occurredAt.getTime() : null,
    },
    runtime: {
      listenAddress: runtime.listenAddress ?? null,
      allowedHosts: [...builtInHosts, ...configuredHosts],
      tailnet: {
        syncedAt: tailnet.syncedAt,
        error: tailnet.lastError,
      },
    },
  }
}
