import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { PriceBook } from './pricing'

// Minimal stand-in for LiteLLM's table: only the Meta rows that exist there
// today. Wonder Full and Wonder's contributor variant have no row anywhere.
const TABLE = {
  'meta/muse-wonder-1.0': { litellm_provider: 'meta', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7 },
  'meta/muse-spark-1.3-contributor': { litellm_provider: 'meta', input_cost_per_token: 1e-7, output_cost_per_token: 2e-7, cache_read_input_token_cost: 2e-9 },
}

function book() {
  const b = new PriceBook(openDb(':memory:'), '/nonexistent/prices.json')
  ;(b as unknown as { table: typeof TABLE }).table = TABLE
  return b
}

describe('muse fallback pricing', () => {
  test('prices Wonder Full at standard Wonder rates', () => {
    const priced = book().lookup('muse-wonder-full-1.0')
    expect(priced?.rates).toEqual({ input: 4_000_000, output: 20_000_000, cacheRead: 200_000, cacheWrite: null })
    expect(priced?.pricedAs).toContain('muse-wonder-1.0')
  })

  test('prices unlisted contributor variants at the contributor rate', () => {
    for (const model of ['muse-wonder-1.0-contributor', 'muse-wonder-full-1.0-contributor']) {
      expect(book().lookup(model)?.rates).toEqual({ input: 100_000, output: 200_000, cacheRead: 2_000, cacheWrite: null })
    }
  })

  test('table entries win over the fallback', () => {
    const priced = book().lookup('muse-spark-1.3-contributor')
    expect(priced?.pricedAs).toBe('meta/muse-spark-1.3-contributor')
  })

  test('unknown models stay unpriced', () => {
    expect(book().lookup('muse-nonexistent-9.9')).toBeNull()
    expect(book().lookup('totally-unknown')).toBeNull()
  })
})

describe('reseller listings', () => {
  test('prefers xAI’s own row for a Grok model a reseller lists first', () => {
    const b = new PriceBook(openDb(':memory:'), '/nonexistent/prices.json')
    ;(b as unknown as { table: object }).table = {
      'azure_ai/grok-code-fast-1': { litellm_provider: 'azure_ai', input_cost_per_token: 2e-7, output_cost_per_token: 1.5e-6 },
      'xai/grok-code-fast-1': { litellm_provider: 'xai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    }
    expect(b.lookup('grok-code-fast-1')?.pricedAs).toBe('xai/grok-code-fast-1')
  })
})

describe('price table loading', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function tempCache(contents?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-test-'))
    const path = join(dir, 'prices.json')
    if (contents !== undefined) writeFileSync(path, JSON.stringify(contents))
    return path
  }

  // A download that never answers until aborted, like a DNS black hole.
  function stallingFetch() {
    let calls = 0
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls++
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as typeof fetch
    return () => calls
  }

  test('start() prices from the cache without waiting for the download', () => {
    stallingFetch()
    const b = new PriceBook(openDb(':memory:'), tempCache(TABLE))
    b.start()
    try {
      expect(b.lookup('muse-wonder-1.0')?.pricedAs).toBe('meta/muse-wonder-1.0')
      expect(b.loadedAt).not.toBeNull()
    } finally {
      b.stop()
    }
  })

  test('a stalled download times out and keeps the cached table', async () => {
    stallingFetch()
    const b = new PriceBook(openDb(':memory:'), tempCache(TABLE))
    b.load()
    expect(await b.refresh(50)).toBe(false)
    expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
  })

  test('a non-JSON response does not replace the table', async () => {
    globalThis.fetch = (async () => new Response('<html>captive portal</html>')) as unknown as typeof fetch
    const b = new PriceBook(openDb(':memory:'), tempCache(TABLE))
    b.load()
    let refreshed = 0
    b.onRefresh = () => refreshed++
    expect(await b.refresh()).toBe(false)
    expect(refreshed).toBe(0)
    expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
  })

  test('a good download replaces the table, writes the cache and notifies', async () => {
    const next = { 'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }
    globalThis.fetch = (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch
    const cache = tempCache()
    const b = new PriceBook(openDb(':memory:'), cache)
    b.load()
    let refreshed = 0
    b.onRefresh = () => refreshed++
    expect(await b.refresh()).toBe(true)
    expect(refreshed).toBe(1)
    expect(b.lookup('claude-opus-5-5')?.rates.input).toBe(5_000_000)
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual(next)
  })

  test('concurrent refreshes share one download', async () => {
    const calls = stallingFetch()
    const b = new PriceBook(openDb(':memory:'), tempCache())
    await Promise.all([b.refresh(50), b.refresh(50)])
    expect(calls()).toBe(1)
  })
})
