import { afterEach, describe, expect, test } from 'bun:test'
import { json, summary } from '../test/fixtures'
import {
  api,
  bucketDay,
  byProviderOrder,
  dailySeries,
  formatCount,
  formatPercent,
  formatTokens,
  formatUsd,
  getUsage,
  isUsageSummary,
  providerColor,
  providerLabel,
  type UsageSummary,
} from './usage'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch
}

describe('formatting', () => {
  test('formatTokens drops decimals as numbers grow and trims trailing zeros', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999.6)).toBe('1000')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_234)).toBe('1.23K')
    expect(formatTokens(849_000_000)).toBe('849M')
    expect(formatTokens(6_000_000_000)).toBe('6B')
    expect(formatTokens(6_040_000_000)).toBe('6.04B')
    expect(formatTokens(19_900_000_000)).toBe('19.9B')
    expect(formatTokens(100_000_000)).toBe('100M')
    expect(formatTokens(2e12)).toBe('2T')
  })

  test('formatPercent shows tiny shares as <0.1%', () => {
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(0.0004)).toBe('<0.1%')
    expect(formatPercent(0.294)).toBe('29.4%')
    expect(formatPercent(1)).toBe('100.0%')
  })

  test('formatUsd and formatCount', () => {
    expect(formatUsd(1_219_020_000)).toBe('$1,219.02')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatCount(1234567)).toBe('1,234,567')
  })
})

describe('providers', () => {
  test('known providers sort in a fixed order, unknown ones after, by name', () => {
    expect(['zeta', 'anthropic', 'gemini', 'openai', 'alpha'].sort(byProviderOrder)).toEqual(['openai', 'anthropic', 'gemini', 'alpha', 'zeta'])
  })

  test('labels and colors fall back for unknown providers', () => {
    expect(providerLabel('openai')).toBe('OpenAI')
    expect(providerLabel('kimi')).toBe('kimi')
    expect(providerColor('gemini')).toBe('var(--gemini)')
    expect(providerColor('kimi')).toBe('var(--fg-3)')
  })
})

describe('series', () => {
  test('bucketDay maps hour keys to local days in the summary time zone', () => {
    const s = { ...summary('7d'), timeZone: 'America/Los_Angeles' }
    const dayOf = bucketDay(s)
    expect(dayOf('2026-11-24')).toBe('2026-11-24')
    // 05:00 UTC is still the previous evening in Los Angeles.
    expect(dayOf(Date.UTC(2026, 10, 24, 5))).toBe('2026-11-23')
    expect(dayOf(Date.UTC(2026, 10, 24, 9))).toBe('2026-11-24')
  })

  test('dailySeries rolls hourly buckets up to local days', () => {
    const series: UsageSummary['series'] = [
      { key: Date.UTC(2026, 10, 23, 22), providers: { openai: { costMicros: 1, tokens: 10 } }, machines: {} },
      { key: Date.UTC(2026, 10, 23, 23), providers: { openai: { costMicros: 2, tokens: 20 } }, machines: { a: { costMicros: 2, tokens: 20 } } },
      { key: Date.UTC(2026, 10, 24, 1), providers: { anthropic: { costMicros: 4, tokens: 40 } }, machines: {} },
    ]
    const s: UsageSummary = { ...summary('7d'), bucket: 'hour', timeZone: 'UTC', series }
    expect(dailySeries(s)).toEqual([
      { key: '2026-11-23', providers: { openai: { costMicros: 3, tokens: 30 } }, machines: { a: { costMicros: 2, tokens: 20 } } },
      { key: '2026-11-24', providers: { anthropic: { costMicros: 4, tokens: 40 } }, machines: {} },
    ])
  })

  test('dailySeries leaves daily series and the 24h range alone', () => {
    const daily = summary('30d')
    expect(dailySeries(daily)).toBe(daily.series)
    const hourly = summary('24h')
    expect(dailySeries(hourly)).toBe(hourly.series)
  })
})

describe('isUsageSummary', () => {
  test('accepts a well-formed summary', () => {
    expect(isUsageSummary(summary())).toBe(true)
    expect(isUsageSummary(summary('24h'))).toBe(true)
  })

  test.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['a null provider row', { ...summary(), providers: [null] }],
    ['a provider row without numbers', { ...summary(), providers: [{ provider: 'openai', sessions: 1 }] }],
    ['a bad bucket', { ...summary(), bucket: 'week' }],
    ['a series point without tokens', { ...summary(), series: [{ key: 'x', providers: { a: { costMicros: 1 } }, machines: {} }] }],
    ['a machine without identities', { ...summary(), byMachine: [{ ...summary().byMachine[0], identities: null }] }],
    ['missing totals.sessions', { ...summary(), totals: { ...summary().totals, sessions: undefined } }],
  ])('rejects %s', (_, payload) => {
    expect(isUsageSummary(payload)).toBe(false)
  })
})

describe('api', () => {
  test('returns the JSON body', async () => {
    stubFetch(async () => json({ ok: 1 }))
    expect(await api<{ ok: number }>('/x')).toEqual({ ok: 1 })
  })

  test('throws the server error message, or the status', async () => {
    stubFetch(async () => json({ error: 'boom' }, 500))
    expect(api('/x')).rejects.toThrow('boom')
    stubFetch(async () => new Response('not json', { status: 502 }))
    expect(api('/x')).rejects.toThrow('HTTP 502')
  })

  test('sends JSON only when there is a body', async () => {
    const seen: (HeadersInit | undefined)[] = []
    stubFetch(async (_, init) => {
      seen.push(init?.headers)
      return json({})
    })
    await api('/a')
    await api('/b', { method: 'PUT', body: '{}' })
    expect(seen).toEqual([undefined, { 'Content-Type': 'application/json' }])
  })

  // Fetch that only settles when its signal aborts.
  // Like real fetch, an already-aborted signal rejects at once.
  const hang = (_: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (init?.signal?.aborted) abort()
      init?.signal?.addEventListener('abort', abort)
    })

  test('times out a hung request', async () => {
    stubFetch(hang)
    expect(api('/x', undefined, 20)).rejects.toThrow('Request timed out')
  })

  test("passes the caller's abort through as an AbortError, not a timeout", async () => {
    stubFetch(hang)
    const controller = new AbortController()
    const request = api('/x', { signal: controller.signal }, 1000)
    controller.abort()
    const err = await request.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })

  test('an already-aborted signal never waits for the timeout', async () => {
    stubFetch(hang)
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await api('/x', { signal: controller.signal }, 5000).catch(() => {})
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('getUsage sends the range and time zone, and rejects a malformed summary', async () => {
    let url = ''
    stubFetch(async (u) => {
      url = u
      return json(summary('7d'))
    })
    expect((await getUsage('7d')).range).toBe('7d')
    expect(url).toStartWith('/api/usage?range=7d&tz=')

    stubFetch(async () => json({ ...summary(), providers: [null] }))
    expect(getUsage('7d')).rejects.toThrow('Unexpected response from the usage server')
  })
})
