import { describe, expect, test } from 'bun:test'
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
  const prices = new PriceBook(db, '/nonexistent/prices.json')
  return { db, app: createApp(db, collector, prices, tailnet, { allowedHosts: overrides.allowedHosts }) }
}

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
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await a.request('/api/import', json('POST', { files: [] }, { 'content-type': type }))
      expect(res.status).toBe(415)
    }
    const noType = await a.request('/api/devices/name', { method: 'DELETE', headers: { host: 'localhost' }, body: '{}' })
    expect(noType.status).toBe(415)
    expect(db.select().from(requests).all()).toHaveLength(0)
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
  const claudeLine = (timestamp: string, id: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      sessionId: 's',
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } },
    })

  test('implausible timestamps are skipped and counted', async () => {
    const lines = [claudeLine('1000-01-01T00:00:00Z', 'a'), claudeLine('2999-01-01T00:00:00Z', 'b'), claudeLine('2025-06-01T00:00:00Z', 'c')]
    const res = await app().app.request('/api/import', json('POST', { files: [{ tool: 'claude-code', lines }] }))
    expect(await res.json()).toMatchObject({ imported: 1, invalidTimestamp: 2 })
  })
})
