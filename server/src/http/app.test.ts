import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { PriceBook } from '../usage/pricing'
import { createApp } from './app'
import { hostAllowed } from './guard'

type Deps = Parameters<typeof createApp>

function app(overrides: { collector?: object; allowedHosts?: string[] } = {}) {
  const db = openDb(':memory:')
  const collector = (overrides.collector ?? { status: { connected: true } }) as Deps[1]
  const tailnet = { syncedAt: null, lastError: null } as unknown as Deps[3]
  const prices = new PriceBook('/nonexistent/prices.json')
  // Mounted the way index.ts mounts it, so sub-app middleware and handlers
  // are exercised through the production routing.
  const root = new Hono()
  root.route('/', createApp(db, collector, prices, tailnet, { allowedHosts: overrides.allowedHosts }))
  root.all('/api/*', (c) => c.json({ error: 'Not found' }, 404)) // as in index.ts
  return { db, app: root }
}

const claudeLine = (timestamp: string, id: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId: 's',
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } },
  })

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { host: 'localhost:5174', 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

describe('Host check (S1)', () => {
  test('accepts loopback, IP literals, localhost, ts.net and this machine', () => {
    for (const host of ['localhost', 'localhost:5174', 'LOCALHOST.', '127.0.0.1:5174', '[::1]:5174', '100.64.0.1', 'dash.localhost', 'dash.tail1234.ts.net']) {
      expect(hostAllowed(host)).toBe(true)
    }
  })

  test('rejects other names, including look-alikes', () => {
    for (const host of [undefined, '', 'evil.example', 'localhost.evil.example', 'ts.net.evil.example', 'evil-ts.net', '[::1']) {
      expect(hostAllowed(host)).toBe(false)
    }
  })

  test('configured names, with a leading dot for subdomains', () => {
    expect(hostAllowed('dash.example.com', ['dash.example.com'])).toBe(true)
    expect(hostAllowed('a.corp.lan:443', ['.corp.lan'])).toBe(true)
    expect(hostAllowed('corp.lan', ['.corp.lan'])).toBe(true)
    expect(hostAllowed('evilcorp.lan', ['.corp.lan'])).toBe(false)
  })

  test('a rebound domain cannot read the API', async () => {
    const res = await app().app.request('/api/usage', { headers: { host: 'attacker.example:5174' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Host') })
  })

  test('USAGE_ALLOWED_HOSTS names are served', async () => {
    const res = await app({ allowedHosts: ['dash.example.com'] }).app.request('/api/health', { headers: { host: 'dash.example.com' } })
    expect(res.status).toBe(200)
  })
})

describe('JSON-only writes (S3)', () => {
  test('cross-site simple requests are refused', async () => {
    const { app: a, db } = app()
    // An import that would insert a row if the handler ran.
    const files = [{ tool: 'claude-code', lines: [claudeLine('2025-06-01T00:00:00Z', 'm1')] }]
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await a.request('/api/import', json('POST', { files }, { 'content-type': type }))
      expect(res.status).toBe(415)
    }
    expect(db.select().from(requests).all()).toHaveLength(0)
    const ok = await a.request('/api/import', json('POST', { files }))
    expect(await ok.json()).toMatchObject({ imported: 1 })
    const noType = await a.request('/api/devices/name', { method: 'DELETE', headers: { host: 'localhost' }, body: '{}' })
    expect(noType.status).toBe(415)
  })

  test('JSON writes go through, with charset parameters', async () => {
    const res = await app().app.request('/api/devices/name', json('PUT', { kind: 'ip', value: '10.0.0.1', name: 'nas' }, { 'content-type': 'Application/JSON; charset=utf-8' }))
    expect(res.status).toBe(200)
  })
})

describe('error handling (R6)', () => {
  test('malformed bodies are 400s with a JSON error', async () => {
    const { app: a } = app()
    for (const body of ['{not json', '[]', 'null', '"text"']) {
      const res = await a.request('/api/devices/name', json('PUT', body))
      expect(res.status).toBe(400)
      expect(await res.json()).toHaveProperty('error')
    }
    const wrongTypes = await a.request('/api/devices/name', json('PUT', { kind: 'ip', value: 1, name: ['x'] }))
    expect(wrongTypes.status).toBe(400)
  })

  test('import skips malformed files instead of crashing', async () => {
    const res = await app().app.request('/api/import', json('POST', { files: [null, 3, { tool: 'codex', lines: [null, 5] }] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ imported: 0 })
  })

  test('unexpected errors become a JSON 500 without internals', async () => {
    const collector = {
      get status(): never {
        throw new Error('secret internal detail')
      },
    }
    const res = await app({ collector }).app.request('/api/health', { headers: { host: 'localhost' } })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Internal server error' })
  })

  test('unknown API paths are JSON 404s', async () => {
    const res = await app().app.request('/api/nope', { headers: { host: 'localhost' } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('import timestamps (D5)', () => {
  test('implausible timestamps are skipped and counted', async () => {
    const lines = [claudeLine('1000-01-01T00:00:00Z', 'a'), claudeLine('2999-01-01T00:00:00Z', 'b'), claudeLine('2025-06-01T00:00:00Z', 'c')]
    const res = await app().app.request('/api/import', json('POST', { files: [{ tool: 'claude-code', lines }] }))
    expect(await res.json()).toMatchObject({ imported: 1, invalidTimestamp: 2 })
  })

  test('a bad-clock copy does not hide the valid copy of the same record', async () => {
    const claude = [claudeLine('1000-01-01T00:00:00Z', 'same'), claudeLine('2025-06-01T00:00:00Z', 'same')]
    const usage = { input_tokens: 5, output_tokens: 5 }
    const codexLine = (timestamp: string) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: usage } } })
    const codex = [
      JSON.stringify({ type: 'turn_context', timestamp: '2025-06-01T00:00:00Z', payload: { model: 'gpt-6.1-sol' } }),
      codexLine('1000-01-01T00:00:00Z'),
      codexLine('2025-06-01T00:00:01Z'),
    ]
    const res = await app().app.request(
      '/api/import',
      json('POST', { files: [{ tool: 'claude-code', lines: claude }, { tool: 'codex', lines: codex }] }),
    )
    expect(await res.json()).toMatchObject({ imported: 2, invalidTimestamp: 2 })
  })

  test('a fork with a bad clock does not suppress the session usage', async () => {
    const usage = { input_tokens: 5, output_tokens: 5 }
    const codex = [
      JSON.stringify({ type: 'session_meta', timestamp: '2999-01-01T00:00:00Z', payload: { id: 'fork', forked_from_id: 'parent' } }),
      JSON.stringify({ type: 'turn_context', timestamp: '2025-06-01T00:00:00Z', payload: { model: 'gpt-6.1-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2025-06-01T00:00:01Z', payload: { type: 'token_count', info: { last_token_usage: usage } } }),
    ]
    const res = await app().app.request('/api/import', json('POST', { files: [{ tool: 'codex', lines: codex }] }))
    expect(await res.json()).toMatchObject({ imported: 1 })
  })

  test('epoch timestamps are counted as invalid', async () => {
    const lines = [claudeLine('1970-01-01T00:00:00.000Z', 'e0'), claudeLine('1970-01-01T00:00:00.001Z', 'e1')]
    const res = await app().app.request('/api/import', json('POST', { files: [{ tool: 'claude-code', lines }] }))
    expect(await res.json()).toMatchObject({ imported: 0, invalidTimestamp: 2 })
  })
})

describe('routes', () => {
  const get = (a: Hono, path: string) => a.request(path, { headers: { host: 'localhost' } })

  test('/api/health reports collector, prices and tailnet state', async () => {
    const res = await get(app().app, '/api/health')
    expect(await res.json()).toEqual({ collector: { connected: true }, pricesLoadedAt: null, tailnet: { syncedAt: null, error: null } })
  })

  test('/api/usage validates the range and defaults to 30 days', async () => {
    const { app: a } = app()
    expect((await get(a, '/api/usage?range=1y')).status).toBe(400)
    const body = (await (await get(a, '/api/usage')).json()) as { series: unknown[]; totals: { records: number } }
    // Without ?tz the server's own zone applies; zone handling is tested below.
    expect(body).toMatchObject({ range: '30d', bucket: 'day' })
    expect(body.series).toHaveLength(30)
  })

  test('/api/usage uses a valid IANA zone and falls back to UTC otherwise', async () => {
    const { app: a } = app()
    expect(await (await get(a, '/api/usage?range=7d&tz=Asia/Shanghai')).json()).toMatchObject({ timeZone: 'Asia/Shanghai', bucket: 'hour' })
    expect(await (await get(a, '/api/usage?tz=Not/AZone')).json()).toMatchObject({ timeZone: 'UTC' })
  })

  test('/api/usage counts imported history', async () => {
    const { app: a } = app()
    const recent = new Date(Date.now() - 3600e3).toISOString()
    const yesterday = new Date(Date.now() - 2 * 3600e3).toISOString()
    // Imports stop at the first live record; with none, anything before now counts.
    await a.request('/api/import', json('POST', { files: [{ tool: 'claude-code', lines: [claudeLine(recent, 'u1'), claudeLine(yesterday, 'u2')] }] }))
    const body = (await (await get(a, '/api/usage?range=24h')).json()) as { series: unknown[]; totals: { records: number } }
    expect(body.totals.records).toBe(2)
  })

  test('/api/import attributes history to the forwarded client', async () => {
    const { app: a, db } = app()
    const files = [{ tool: 'claude-code', lines: [claudeLine('2025-06-01T00:00:00Z', 'fwd')] }]
    const res = await a.request('/api/import', json('POST', { files }, { 'x-forwarded-for': '100.64.0.5, 10.0.0.1' }))
    expect(await res.json()).toMatchObject({ machineIp: '100.64.0.5', imported: 1 })
    expect(db.select().from(requests).all().map((r) => r.clientIp)).toEqual(['100.64.0.5'])
    const direct = await app().app.request('/api/import', json('POST', { files: [] }))
    expect(await direct.json()).toMatchObject({ machineIp: '127.0.0.1' })
  })

  test('/api/devices name and clear round trip', async () => {
    const { app: a } = app()
    expect((await a.request('/api/devices/name', json('PUT', { kind: 'ip', value: '10.0.0.9', name: '  nas  ' }))).status).toBe(200)
    let devices = await (await get(a, '/api/devices')).json()
    expect(devices).toEqual([expect.objectContaining({ kind: 'ip', value: '10.0.0.9', name: 'nas', nameSource: 'custom' })])

    expect((await a.request('/api/devices/name', json('DELETE', { kind: 'ip', value: '10.0.0.9' }))).status).toBe(200)
    devices = await (await get(a, '/api/devices')).json()
    expect(devices).toEqual([])
  })

  test('/api/devices/name rejects bad kinds and blank names', async () => {
    const { app: a } = app()
    expect((await a.request('/api/devices/name', json('PUT', { kind: 'mac', value: 'x', name: 'y' }))).status).toBe(400)
    expect((await a.request('/api/devices/name', json('PUT', { kind: 'ip', value: 'x', name: '   ' }))).status).toBe(400)
    expect((await a.request('/api/devices/name', json('DELETE', { kind: 'ip' }))).status).toBe(400)
  })
})
