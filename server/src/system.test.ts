import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { requests } from './db/schema'
import { createApp } from './http/app'
import { systemInfo } from './system'
import type { Tailnet } from './tailnet'
import { PriceBook } from './usage/pricing'

function makePriceBook(table: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-sys-'))
  const file = join(dir, 'prices.json')
  writeFileSync(file, JSON.stringify(table))
  const prices = new PriceBook(file)
  prices.load()
  return { prices, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeCollector(overrides: Partial<CliproxyCollector['status']> = {}) {
  let reconnected = 0
  const status = {
    connected: true,
    authFailed: false,
    since: 1_700_000_000_000,
    downSince: null,
    lastRecordAt: 1_700_000_010_000,
    stored: 42,
    lastError: null,
    ...overrides,
  }
  const collector = {
    target: 'http://127.0.0.1:8317',
    keyConfigured: true,
    status,
    reconnect() {
      reconnected += 1
      status.authFailed = false
      status.lastError = null
    },
  } as unknown as CliproxyCollector
  return { collector, getReconnected: () => reconnected }
}

const tailnet = { syncedAt: 1_700_000_005_000, lastError: null } as unknown as Tailnet

describe('systemInfo & /api/system', () => {
  test('reports collector status, used model pricing with tiers, storage and runtime without leaking secrets', () => {
    const db = openDb(':memory:')
    const { prices, cleanup } = makePriceBook({
      'claude-sonnet-4-5': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 0.3e-6,
        cache_creation_input_token_cost: 3.75e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 22.5e-6,
      },
    })
    try {
      const now = new Date('2026-05-01T12:00:00Z')
      db.insert(requests)
        .values([
          {
            id: 'r1',
            source: 'cliproxy',
            occurredAt: now,
            receivedAt: now,
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            failed: false,
            inputTokens: 1000,
            outputTokens: 500,
            costMicros: 10_500,
            cacheSavingsMicros: 0,
            pricedAs: 'claude-sonnet-4-5',
          },
          {
            id: 'r2',
            source: 'cliproxy',
            occurredAt: new Date(now.getTime() + 1000),
            receivedAt: now,
            provider: 'anthropic',
            model: 'unknown-preview-model',
            failed: false,
            inputTokens: 100,
            outputTokens: 50,
            costMicros: null,
            cacheSavingsMicros: null,
            pricedAs: null,
          },
        ])
        .run()

      const { collector } = makeCollector()
      const info = systemInfo(db, collector, prices, tailnet, {
        dbPath: ':memory:',
        listenAddress: '127.0.0.1:5174',
        allowedHosts: ['dash.example.com'],
      })

      expect(info.collector.target).toBe('http://127.0.0.1:8317')
      expect(info.collector.keyConfigured).toBe(true)
      expect(JSON.stringify(info)).not.toContain('managementKey')

      expect(info.pricing.totalCatalogModels).toBe(1)
      expect(info.pricing.usedModels).toHaveLength(2)

      const sonnet = info.pricing.usedModels.find((m) => m.model === 'claude-sonnet-4-5')!
      expect(sonnet.matchKind).toBe('exact')
      expect(sonnet.pricedAs).toBe('claude-sonnet-4-5')
      expect(sonnet.rates?.input).toBe(3_000_000)
      expect(sonnet.rates?.output).toBe(15_000_000)
      expect(sonnet.rates?.tiers).toHaveLength(1)
      expect(sonnet.rates?.tiers?.[0].aboveTokens).toBe(200_000)

      const unknown = info.pricing.usedModels.find((m) => m.model === 'unknown-preview-model')!
      expect(unknown.matchKind).toBe('unpriced')
      expect(unknown.unpricedRequests).toBe(1)
      expect(unknown.rates).toBeNull()

      expect(info.storage.totalRequests).toBe(2)
      expect(info.storage.unpricedRequests).toBe(1)
      expect(info.storage.earliestAt).toBe(now.getTime())
      expect(info.storage.latestAt).toBe(now.getTime() + 1000)
      expect(info.runtime.listenAddress).toBe('127.0.0.1:5174')
      expect(info.runtime.allowedHosts).toContain('dash.example.com')
    } finally {
      cleanup()
    }
  })

  test('HTTP endpoints enforce JSON writes and trigger reconnect & pricing refresh', async () => {
    const db = openDb(':memory:')
    const { collector, getReconnected } = makeCollector({ connected: false, authFailed: true, lastError: 'ERR auth' })
    const prices = new PriceBook('/nonexistent/prices.json')
    let refreshCalls = 0
    prices.refresh = async () => {
      refreshCalls += 1
      return true
    }

    const root = new Hono()
    root.route('/', createApp(db, collector, prices, tailnet, { dbPath: ':memory:', listenAddress: '127.0.0.1:5174' }))

    const sysRes = await root.request('/api/system', { headers: { host: 'localhost:5174' } })
    expect(sysRes.status).toBe(200)
    const sys = (await sysRes.json()) as { collector: { authFailed: boolean; target: string } }
    expect(sys.collector.authFailed).toBe(true)
    expect(sys.collector.target).toBe('http://127.0.0.1:8317')

    // Missing JSON content-type must be rejected by requireJsonWrites.
    const badReconnect = await root.request('/api/collector/reconnect', {
      method: 'POST',
      headers: { host: 'localhost:5174' },
      body: '{}',
    })
    expect(badReconnect.status).toBe(415)

    const okReconnect = await root.request('/api/collector/reconnect', {
      method: 'POST',
      headers: { host: 'localhost:5174', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(okReconnect.status).toBe(200)
    expect(getReconnected()).toBe(1)

    const okRefresh = await root.request('/api/pricing/refresh', {
      method: 'POST',
      headers: { host: 'localhost:5174', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(okRefresh.status).toBe(200)
    expect(await okRefresh.json()).toMatchObject({
      ok: true,
      downloaded: true,
      repriced: true,
      error: null,
      totalCatalogModels: 0,
    })
    expect(refreshCalls).toBe(1)

    // When download succeeds but repricing fails, report ok: false with error.
    prices.lastRepriceError = 'SQLITE_BUSY'
    const partialRefresh = await root.request('/api/pricing/refresh', {
      method: 'POST',
      headers: { host: 'localhost:5174', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(partialRefresh.status).toBe(200)
    expect(await partialRefresh.json()).toMatchObject({
      ok: false,
      downloaded: true,
      repriced: false,
      error: 'SQLITE_BUSY',
    })
  })
})
