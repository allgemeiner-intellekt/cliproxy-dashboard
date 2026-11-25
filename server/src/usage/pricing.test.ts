import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheSavingsOf, costOf, PriceBook } from './pricing'

// Minimal stand-in for LiteLLM's table: only the Meta rows that exist there
// today. Wonder Full and Wonder's contributor variant have no row anywhere.
const TABLE = {
  'meta/muse-wonder-1.0': { litellm_provider: 'meta', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7 },
  'meta/muse-spark-1.3-contributor': { litellm_provider: 'meta', input_cost_per_token: 1e-7, output_cost_per_token: 2e-7, cache_read_input_token_cost: 2e-9 },
}

function book() {
  const b = new PriceBook('/nonexistent/prices.json')
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
    const b = new PriceBook('/nonexistent/prices.json')
    ;(b as unknown as { table: object }).table = {
      'azure_ai/grok-code-fast-1': { litellm_provider: 'azure_ai', input_cost_per_token: 2e-7, output_cost_per_token: 1.5e-6 },
      'xai/grok-code-fast-1': { litellm_provider: 'xai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    }
    expect(b.lookup('grok-code-fast-1')?.pricedAs).toBe('xai/grok-code-fast-1')
  })
})

describe('price table loading', () => {
  const realFetch = globalThis.fetch
  const dirs: string[] = []
  afterEach(() => {
    globalThis.fetch = realFetch
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempCache(contents?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-test-'))
    dirs.push(dir)
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
    const b = new PriceBook(tempCache(TABLE))
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
    const b = new PriceBook(tempCache(TABLE))
    b.load()
    expect(await b.refresh(50)).toBe(false)
    expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
  })

  test('a non-JSON response does not replace the table', async () => {
    globalThis.fetch = (async () => new Response('<html>captive portal</html>')) as unknown as typeof fetch
    const b = new PriceBook(tempCache(TABLE))
    b.load()
    let refreshed = 0
    b.onRefresh = () => refreshed++
    expect(await b.refresh()).toBe(false)
    expect(refreshed).toBe(0)
    expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
  })

  test('a JSON object with malformed entries does not replace the table', async () => {
    for (const body of [{ 'test-model': null }, { 'test-model': { input_cost_per_token: 'free' } }, {}]) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
      const cache = tempCache(TABLE)
      const b = new PriceBook(cache)
      b.load()
      expect(await b.refresh()).toBe(false)
      expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
      expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual(TABLE)
    }
  })

  test('malformed entries in an otherwise good table are skipped, not fatal', async () => {
    const next = { ...TABLE, broken: null, half: { input_cost_per_token: 1e-6, output_cost_per_token: 'x' } }
    globalThis.fetch = (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch
    const b = new PriceBook(tempCache())
    expect(await b.refresh()).toBe(true)
    expect(b.lookup('broken')).toBeNull()
    expect(b.lookup('half')).toBeNull()
    expect(b.lookup('muse-wonder-1.0')).not.toBeNull()
  })

  test('an unusable first-party entry falls through to a reseller listing', async () => {
    const next = {
      'test-model': { litellm_provider: 'openai', input_cost_per_token: 'bad', output_cost_per_token: 1e-6 },
      'reseller/test-model': { litellm_provider: 'azure', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    }
    globalThis.fetch = (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch
    const b = new PriceBook(tempCache())
    expect(await b.refresh()).toBe(true)
    expect(b.lookup('test-model')?.pricedAs).toBe('reseller/test-model')
  })

  test('a failed cache write keeps the previous cache intact', async () => {
    const next = { 'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }
    globalThis.fetch = (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch
    const cache = tempCache(TABLE)
    mkdirSync(`${cache}.${process.pid}.tmp`) // the temp file can't be written
    const b = new PriceBook(cache)
    expect(await b.refresh()).toBe(true)
    expect(b.lookup('claude-opus-5-5')).not.toBeNull()
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual(TABLE)
  })

  test('stop() during a refresh schedules nothing afterwards', async () => {
    let release!: (r: Response) => void
    globalThis.fetch = (() => new Promise<Response>((resolve) => (release = resolve))) as unknown as typeof fetch
    const b = new PriceBook(tempCache())
    const first = b.start()
    expect(b.start()).toBe(first) // idempotent while running
    b.stop()
    release(new Response(JSON.stringify(TABLE)))
    expect(await first).toBe(true)
    expect((b as unknown as { timer?: unknown }).timer).toBeUndefined()
  })

  test('a good download replaces the table, writes the cache and notifies', async () => {
    const next = { 'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }
    globalThis.fetch = (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch
    const cache = tempCache()
    const b = new PriceBook(cache)
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
    const b = new PriceBook(tempCache())
    await Promise.all([b.refresh(50), b.refresh(50)])
    expect(calls()).toBe(1)
  })
})

describe('long-context tiers (D8)', () => {
  const book = (table: Record<string, unknown>) => {
    const b = new PriceBook('/nonexistent/prices.json')
    ;(b as unknown as { setTable: (t: unknown) => void }).setTable(table)
    return b
  }
  const LONG = {
    litellm_provider: 'anthropic',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
  }

  test('tier fields are parsed from a downloaded table', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ 'claude-sonnet-5': LONG }))) as unknown as typeof fetch
    try {
      const b = new PriceBook('/nonexistent/dir/prices.json')
      await b.refresh()
      expect(b.lookup('claude-sonnet-5')?.rates.tiers).toEqual([
        { aboveTokens: 200_000, rates: { input: 6_000_000, output: 22_500_000, cacheRead: 300_000, cacheWrite: null } },
      ])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a prompt over the threshold bills every token at the tier rate', () => {
    const rates = { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: null, tiers: [{ aboveTokens: 200_000, rates: { input: 6_000_000, output: 22_500_000, cacheRead: 600_000, cacheWrite: null } }] }
    // 200k prompt exactly: base rates.
    expect(costOf({ input: 200_000, cacheRead: 0, cacheWrite: 0, output: 1000 }, rates)).toBe(600_000 + 15_000)
    // Cache reads count toward the prompt: 150k + 100k > 200k.
    expect(costOf({ input: 150_000, cacheRead: 100_000, cacheWrite: 0, output: 1000 }, rates)).toBe(900_000 + 60_000 + 22_500)
    expect(cacheSavingsOf({ input: 150_000, cacheRead: 100_000, cacheWrite: 0, output: 0 }, rates)).toBe(540_000)
  })

  test('untiered models are unchanged', () => {
    const b = book({ 'gpt-6.1-sol': { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 } })
    expect(b.lookup('gpt-6.1-sol')?.rates).toEqual({ input: 1_000_000, output: 10_000_000, cacheRead: null, cacheWrite: null })
  })
})

describe('lookup cache (P5)', () => {
  test('a new table replaces cached results, including misses', async () => {
    const realFetch = globalThis.fetch
    const b = new PriceBook('/nonexistent/dir/prices.json')
    expect(b.lookup('claude-later')).toBeNull()
    globalThis.fetch = (async () => new Response(JSON.stringify({ 'claude-later': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }))) as unknown as typeof fetch
    try {
      await b.refresh()
      expect(b.lookup('claude-later')?.pricedAs).toBe('claude-later')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('model names are matched case-insensitively', () => {
    const b = new PriceBook('/nonexistent/prices.json')
    ;(b as unknown as { setTable: (t: unknown) => void }).setTable({ 'gpt-6.1-sol': { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 } })
    expect(b.lookup(' GPT-6.1-Sol ')?.pricedAs).toBe('gpt-6.1-sol')
  })
})

describe('first-party preference', () => {
  test("a bare Gemini name takes Google's listing, with its long-context tier, over a reseller's", () => {
    const b = new PriceBook('/nonexistent/prices.json')
    ;(b as unknown as { setTable: (t: unknown) => void }).setTable({
      'deepinfra/google/gemini-2.5-pro': { litellm_provider: 'deepinfra', input_cost_per_token: 8.75e-7, output_cost_per_token: 7e-6 },
      'gemini/gemini-2.5-pro': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 1e-5,
        tiers: { 200000: { input_cost_per_token: 2.5e-6, output_cost_per_token: 1.5e-5 } },
      },
    })
    const priced = b.lookup('gemini-2.5-pro')
    expect(priced?.pricedAs).toBe('gemini/gemini-2.5-pro')
    // 250k input + 10k output at the >200k rates: $0.625 + $0.15.
    expect(costOf({ input: 250_000, cacheRead: 0, cacheWrite: 0, output: 10_000 }, priced!.rates)).toBe(775_000)
  })
})
