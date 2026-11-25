// Transcript parsing for history imports: token arithmetic, deduplication
// and fork handling decide whether history is counted once, exactly.

import { describe, expect, test } from 'bun:test'
import { newCodexState, parseClaudeLine, parseCodexLine } from './transcripts'

const claude = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2025-06-01T00:00:00.000Z',
    sessionId: 'sess',
    requestId: 'req_1',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 40 }, ...message },
    ...overrides,
  })

describe('parseClaudeLine', () => {
  test('maps usage fields; Anthropic input already excludes cache tokens', () => {
    expect(parseClaudeLine(claude())).toEqual({
      tool: 'claude-code',
      timestampMs: Date.UTC(2025, 5, 1),
      model: 'claude-opus-5-5',
      sessionId: 'sess',
      uncached: 10,
      cacheRead: 200,
      cacheWrite: 30,
      output: 40,
      reasoning: 0,
      key: 'msg_1:req_1',
    })
  })

  test('lines that are not assistant usage are skipped', () => {
    for (const line of ['', 'not json', JSON.stringify({ type: 'user' }), claude({ timestamp: 'nope' }), claude({}, { usage: null }), claude({}, { model: 3 })]) {
      expect(parseClaudeLine(line)).toBeNull()
    }
    // Neither a message id nor a request id: no stable key, so not importable.
    expect(parseClaudeLine(claude({ requestId: undefined }, { id: undefined }))).toBeNull()
  })

  test('repeated lines of one message share a key (the importer keeps the first)', () => {
    expect(parseClaudeLine(claude({ timestamp: '2025-06-01T00:00:05Z' }))?.key).toBe(parseClaudeLine(claude())?.key)
  })

  test('negative or fractional token counts are clamped and rounded', () => {
    const r = parseClaudeLine(claude({}, { usage: { input_tokens: -5, output_tokens: 2.6 } }))
    expect(r).toMatchObject({ uncached: 0, output: 3, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('parseCodexLine', () => {
  const meta = (payload: Record<string, unknown>, timestamp = '2025-06-01T00:00:00.000Z') =>
    JSON.stringify({ type: 'session_meta', timestamp, payload })
  const context = (model: string) => JSON.stringify({ type: 'turn_context', timestamp: '2025-06-01T00:00:00Z', payload: { model } })
  const tokens = (timestamp: string, usage: Record<string, number>) =>
    JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } } })
  const run = (lines: string[]) => {
    const state = newCodexState()
    return lines.map((l) => parseCodexLine(l, state)).filter((r) => r !== null)
  }

  test('Codex input includes cached tokens; uncached is the remainder', () => {
    const [r] = run([meta({ id: 'S1' }), context('gpt-6.1-sol'), tokens('2025-06-01T00:00:10Z', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 })])
    expect(r).toMatchObject({ tool: 'codex', model: 'gpt-6.1-sol', sessionId: 'S1', uncached: 200, cacheRead: 800, output: 50, reasoning: 20 })
  })

  test('reasoning never exceeds output, and uncached never goes negative', () => {
    const [r] = run([context('m'), tokens('2025-06-01T00:00:10Z', { input_tokens: 10, cached_input_tokens: 50, output_tokens: 5, reasoning_output_tokens: 9 })])
    expect(r).toMatchObject({ uncached: 0, reasoning: 5 })
  })

  test('the model comes from the latest turn_context; none yet means skip', () => {
    const records = run([
      tokens('2025-06-01T00:00:01Z', { input_tokens: 1, output_tokens: 1 }),
      context('gpt-a'),
      tokens('2025-06-01T00:00:02Z', { input_tokens: 2, output_tokens: 1 }),
      context('gpt-b'),
      tokens('2025-06-01T00:00:03Z', { input_tokens: 3, output_tokens: 1 }),
    ])
    expect(records.map((r) => r.model)).toEqual(['gpt-a', 'gpt-b'])
  })

  // token_count with a cumulative total, as current Codex writes it.
  const counted = (timestamp: string, usage: Record<string, number>, total: Record<string, number>) =>
    JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: total } } })

  test('a re-emitted token_count (same cumulative total) is counted once', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const records = run([
      context('m'),
      counted('2025-06-01T00:00:01Z', usage, { input_tokens: 5, output_tokens: 5 }),
      counted('2025-06-01T00:00:02Z', usage, { input_tokens: 5, output_tokens: 5 }), // re-emit
      counted('2025-06-01T00:00:03Z', { input_tokens: 7, output_tokens: 1 }, { input_tokens: 12, output_tokens: 6 }),
    ])
    expect(records.map((r) => [r.timestampMs, r.uncached])).toEqual([
      [Date.UTC(2025, 5, 1, 0, 0, 1), 5],
      [Date.UTC(2025, 5, 1, 0, 0, 3), 7],
    ])
  })

  test('two real requests with identical usage are both counted (the total advances)', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const records = run([
      context('m'),
      counted('2025-06-01T00:00:01Z', usage, { input_tokens: 5, output_tokens: 5 }),
      counted('2025-06-01T00:00:02Z', usage, { input_tokens: 10, output_tokens: 10 }),
    ])
    expect(records).toHaveLength(2)
    expect(new Set(records.map((r) => r.key)).size).toBe(2)
  })

  test('rollouts without a total fall back to comparing the usage itself', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const records = run([context('m'), tokens('2025-06-01T00:00:01Z', usage), tokens('2025-06-01T00:00:02Z', usage), tokens('2025-06-01T00:00:03Z', { ...usage, output_tokens: 6 })])
    expect(records.map((r) => r.output)).toEqual([5, 6])
  })

  test('the key does not depend on the total, so earlier imports still match', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const [withTotal] = run([meta({ id: 'S' }), context('m'), counted('2025-06-01T00:00:01Z', usage, { input_tokens: 99, output_tokens: 99 })])
    const [without] = run([meta({ id: 'S' }), context('m'), tokens('2025-06-01T00:00:01Z', usage)])
    expect(withTotal.key).toBe(without.key)
  })

  test('all-zero usage is skipped', () => {
    expect(run([context('m'), tokens('2025-06-01T00:00:01Z', { input_tokens: 0, output_tokens: 0 })])).toHaveLength(0)
  })

  test("a fork's leading burst of copied parent events is skipped, later usage counted", () => {
    const records = run([
      meta({ id: 'FORK', forked_from_id: 'PARENT' }, '2025-06-01T00:00:00.000Z'),
      context('m'),
      // Copies replayed within a second of each other.
      tokens('2025-06-01T00:00:00.300Z', { input_tokens: 1, output_tokens: 1 }),
      tokens('2025-06-01T00:00:00.900Z', { input_tokens: 2, output_tokens: 1 }),
      // The fork's own work, after a pause.
      tokens('2025-06-01T00:00:30.000Z', { input_tokens: 3, output_tokens: 1 }),
    ])
    expect(records.map((r) => r.uncached)).toEqual([3])
    expect(records[0].sessionId).toBe('FORK')
  })

  test("a fork's copied burst with advancing totals doesn't swallow the fork's first request", () => {
    const usage = { input_tokens: 4, output_tokens: 1 }
    const records = run([
      meta({ id: 'FORK', forked_from_id: 'PARENT' }, '2025-06-01T00:00:00.000Z'),
      context('m'),
      // Two copied parent requests: same per-request usage, advancing totals.
      counted('2025-06-01T00:00:00.100Z', usage, { input_tokens: 4, output_tokens: 1 }),
      counted('2025-06-01T00:00:00.900Z', usage, { input_tokens: 8, output_tokens: 2 }),
      // The fork's own first request, 1.4s after the burst began.
      counted('2025-06-01T00:00:01.500Z', { input_tokens: 9, output_tokens: 3 }, { input_tokens: 17, output_tokens: 5 }),
    ])
    expect(records.map((r) => r.uncached)).toEqual([9])
  })

  test('distinct requests sharing a millisecond and usage get distinct keys; the first keeps the plain key', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const at = '2025-06-01T12:00:02.123Z'
    const records = run([
      meta({ id: 'S' }),
      context('m'),
      counted(at, usage, { input_tokens: 5, output_tokens: 5 }),
      counted(at, usage, { input_tokens: 10, output_tokens: 10 }),
      counted(at, usage, { input_tokens: 15, output_tokens: 15 }),
    ])
    const plain = `S:${Date.parse(at)}:${JSON.stringify(usage)}`
    expect(records.map((r) => r.key)).toEqual([plain, `${plain}#2`, `${plain}#3`])
  })

  test('events after the cutoff are returned but claim no dedup state', () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const state = newCodexState(Date.parse('2025-06-01T12:00:03Z'))
    const parse = (l: string) => parseCodexLine(l, state)
    parse(context('m'))
    // A late copy first, then its eligible copy (same total).
    const late = parse(counted('2025-06-01T12:00:04Z', usage, { input_tokens: 5, output_tokens: 5 }))
    const early = parse(counted('2025-06-01T12:00:02Z', usage, { input_tokens: 5, output_tokens: 5 }))
    expect(late?.timestampMs).toBe(Date.parse('2025-06-01T12:00:04Z'))
    expect(early?.timestampMs).toBe(Date.parse('2025-06-01T12:00:02Z'))
  })

  test('subagent rollouts are treated as forks too', () => {
    const records = run([
      meta({ id: 'SUB', source: { subagent: { thread_spawn: { parent_thread_id: 'P' } } } }),
      context('m'),
      tokens('2025-06-01T00:00:00.500Z', { input_tokens: 1, output_tokens: 1 }),
    ])
    expect(records).toHaveLength(0)
  })

  test("only the first session_meta names the session (forks repeat ancestors' metas)", () => {
    const [r] = run([meta({ id: 'OWN' }), meta({ id: 'ANCESTOR' }), context('m'), tokens('2025-06-01T00:00:10Z', { input_tokens: 1, output_tokens: 1 })])
    expect(r.sessionId).toBe('OWN')
  })

  test('keys are stable across re-parses and differ per event', () => {
    const lines = [meta({ id: 'S' }), context('m'), tokens('2025-06-01T00:00:01Z', { input_tokens: 1, output_tokens: 1 }), tokens('2025-06-01T00:00:02Z', { input_tokens: 2, output_tokens: 1 })]
    const first = run(lines).map((r) => r.key)
    expect(run(lines).map((r) => r.key)).toEqual(first)
    expect(new Set(first).size).toBe(2)
  })
})
