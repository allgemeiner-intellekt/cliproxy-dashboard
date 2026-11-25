// CLIProxyAPI usage record → stored row. These fields decide what the
// dashboard reports, so each mapping rule is pinned here.

import { describe, expect, test } from 'bun:test'
import { hashKey, isUsageRecord, toRequestRow, type CliproxyRecord } from './cliproxy-record'
import { PriceBook } from './pricing'

function prices() {
  const b = new PriceBook('/nonexistent/prices.json')
  ;(b as unknown as { table: unknown }).table = {
    'gpt-6.1-sol': { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 },
    'gpt-6.1-sol-mini': { litellm_provider: 'openai', input_cost_per_token: 1e-7, output_cost_per_token: 1e-6 },
  }
  return b
}

const record = (overrides: Partial<CliproxyRecord> & Record<string, unknown> = {}): CliproxyRecord => ({
  timestamp: '2026-11-24T12:00:00.000Z',
  request_id: 'req-1',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  failed: false,
  ...overrides,
})

describe('isUsageRecord', () => {
  test('control messages and malformed values are not usage records', () => {
    for (const value of [null, 'text', 42, [], { support_refresh: true }, { ...record(), model: '' }, { ...record(), request_id: '' }]) {
      expect(isUsageRecord(value)).toBe(false)
    }
    expect(isUsageRecord(record())).toBe(true)
  })
})

describe('toRequestRow', () => {
  test('a stable id, so a redelivered record is stored once', () => {
    const a = toRequestRow(record({ execution_id: 'exec-9' }), prices())
    const b = toRequestRow(record({ execution_id: 'exec-9' }), prices())
    expect(a.id).toBe('cliproxy:exec-9:2026-11-24T12:00:00.000Z')
    expect(b.id).toBe(a.id)
    // Without an execution id, the request id identifies it.
    expect(toRequestRow(record(), prices()).id).toBe('cliproxy:req-1:2026-11-24T12:00:00.000Z')
  })

  test('v2 token_breakdown wins over the legacy tokens object', () => {
    const row = toRequestRow(
      record({
        tokens: { input_tokens: 999, output_tokens: 999, cache_read_tokens: 999 },
        token_breakdown: {
          input: { uncached_tokens: 100, cache_read_tokens: 1000, cache_write_tokens: 10 },
          output: { total_tokens: 50, reasoning_tokens: 20 },
        },
      }),
      prices(),
    )
    expect(row).toMatchObject({ inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 10, outputTokens: 50, reasoningTokens: 20 })
  })

  test('legacy tokens map field by field, truncating and dropping non-numbers', () => {
    const row = toRequestRow(
      record({ tokens: { input_tokens: 12.9, output_tokens: 3, cache_read_tokens: 'x' as unknown as number, cache_creation_tokens: 4, reasoning_tokens: 1 } }),
      prices(),
    )
    expect(row).toMatchObject({ inputTokens: 12, cacheReadTokens: null, cacheWriteTokens: 4, outputTokens: 3, reasoningTokens: 1 })
  })

  test('prices by the model that served the request, keeping the requested alias', () => {
    const row = toRequestRow(
      record({ model: 'gpt-6.1-sol', response_model: 'gpt-6.1-sol-mini', alias: 'fast', tokens: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
      prices(),
    )
    expect(row).toMatchObject({ model: 'gpt-6.1-sol-mini', requestedModel: 'fast', pricedAs: 'gpt-6.1-sol-mini' })
    // $0.10 + $1.00 per million, in micro-dollars.
    expect(row.costMicros).toBe(1_100_000)
  })

  test('cost and cache savings from the price table; unknown models stay unpriced', () => {
    const priced = toRequestRow(record({ tokens: { input_tokens: 1_000_000, cache_read_tokens: 1_000_000, output_tokens: 0 } }), prices())
    expect(priced.costMicros).toBe(1_000_000 + 100_000)
    expect(priced.cacheSavingsMicros).toBe(900_000)
    const unknown = toRequestRow(record({ model: 'mystery-model' }), prices())
    expect(unknown).toMatchObject({ costMicros: null, cacheSavingsMicros: null, pricedAs: null })
  })

  test('the client key is stored only as a short hash', () => {
    const row = toRequestRow(record({ api_key: 'sk-very-secret' }), prices())
    expect(row.clientKeyHash).toBe(hashKey('sk-very-secret'))
    expect(row.clientKeyHash).toHaveLength(16)
    expect(JSON.stringify(row)).not.toContain('sk-very-secret')
    expect(toRequestRow(record({ api_key: '' }), prices()).clientKeyHash).toBeNull()
  })

  test('the client IP is the first X-Forwarded-For hop (tailscale serve), else the socket address', () => {
    expect(toRequestRow(record({ client_ip: '127.0.0.1', x_forwarded_for: '100.64.0.7, 10.0.0.1' }), prices()).clientIp).toBe('100.64.0.7')
    expect(toRequestRow(record({ client_ip: '192.168.1.5' }), prices()).clientIp).toBe('192.168.1.5')
    expect(toRequestRow(record({ client_ip: '192.168.1.5', x_forwarded_for: ' ' }), prices()).clientIp).toBe('192.168.1.5')
    expect(toRequestRow(record(), prices()).clientIp).toBeNull()
  })

  test('the tool is recognised from the user agent', () => {
    const tool = (ua?: string) => toRequestRow(record({ user_agent: ua }), prices()).tool
    expect(tool('claude-cli/2.1.0 (external, cli)')).toBe('claude-code')
    expect(tool('muse-code/1.0')).toBe('muse-code')
    expect(tool('codex_cli_rs/0.40.0')).toBe('codex')
    expect(tool('OpenAI/Python 1.99')).toBe('OpenAI')
    expect(tool(undefined)).toBeNull()
  })

  test('failure, status and timings, ignoring wrong types', () => {
    const row = toRequestRow(record({ failed: true, fail: { status_code: 429 }, latency_ms: 1234.7, ttft_ms: 'slow' as unknown as number }), prices())
    expect(row).toMatchObject({ failed: true, statusCode: 429, latencyMs: 1234, timeToFirstTokenMs: null })
  })

  test('account, session and endpoint are kept; empty strings become null', () => {
    const row = toRequestRow(record({ auth_index: '3', source: 'me@example.com', session_id: 's-1', endpoint: '/v1/responses' }), prices())
    expect(row).toMatchObject({ accountRef: '3', accountLabel: 'me@example.com', sessionId: 's-1', endpoint: '/v1/responses', source: 'cliproxy' })
    expect(toRequestRow(record({ session_id: '', source: '' }), prices())).toMatchObject({ sessionId: null, accountLabel: null })
  })

  test('the stored time is the record time, not the receive time', () => {
    const row = toRequestRow(record({ timestamp: '2026-01-02T03:04:05.678Z' }), prices())
    expect(row.occurredAt.getTime()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 678))
  })
})
