import { describe, expect, test } from 'bun:test'
import type { CliproxyCollector, CollectorStatus } from '../collector/cliproxy'
import { openDb } from '../db/client'
import type { Tailnet } from '../tailnet'
import type { PriceBook } from '../usage/pricing'
import { COLLECTOR_DOWN_MS, collectorDown, createApp } from './app'

const now = Date.UTC(2026, 10, 24, 12)
const status = (s: Partial<CollectorStatus>): CollectorStatus => ({
  connected: false, since: null, downSince: null, lastRecordAt: null, stored: 0, lastError: null, ...s,
})

describe('collectorDown', () => {
  test('connected is healthy', () => {
    expect(collectorDown(status({ connected: true, since: now - 1e6 }), now)).toBe(false)
  })
  test('a short disconnect is tolerated', () => {
    expect(collectorDown(status({ downSince: now - COLLECTOR_DOWN_MS }), now)).toBe(false)
  })
  test('a long disconnect is unhealthy', () => {
    expect(collectorDown(status({ downSince: now - COLLECTOR_DOWN_MS - 1 }), now)).toBe(true)
  })
})

describe('GET /api/health', () => {
  const request = (s: CollectorStatus) => {
    const app = createApp(
      openDb(':memory:'),
      { status: s } as CliproxyCollector,
      { loadedAt: null } as PriceBook,
      { syncedAt: null, lastError: null } as Tailnet,
    )
    return app.request('/api/health')
  }

  test('200 while the collector is connected', async () => {
    const res = await request(status({ connected: true, since: Date.now() }))
    expect(res.status).toBe(200)
  })

  test('503 with the status body once the collector has been down too long', async () => {
    const res = await request(status({ downSince: Date.now() - COLLECTOR_DOWN_MS - 1000, lastError: 'ECONNREFUSED' }))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { collector: CollectorStatus }
    expect(body.collector.lastError).toBe('ECONNREFUSED')
  })
})
