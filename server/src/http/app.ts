// HTTP API for the usage dashboard and external consumers.

import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { CliproxyCollector, CollectorStatus } from '../collector/cliproxy'
import type { Db } from '../db/client'
import { importTranscripts, type TranscriptFile } from '../import/importer'
import { clearIdentityName, listDevices, nameIdentity, type IdentityKind } from '../machines'
import type { Tailnet } from '../tailnet'
import type { PriceBook } from '../usage/pricing'
import { RANGES, usageSummary, type Range } from '../usage/summary'
import { errorFields, log } from '../log'
import { requireJsonWrites, requireKnownHost } from './guard'

// Longer than a few reconnect attempts (backoff tops out at 30 s).
export const COLLECTOR_DOWN_MS = 120e3

export const collectorDown = (status: CollectorStatus, now = Date.now()) =>
  !status.connected && status.downSince !== null && now - status.downSince > COLLECTOR_DOWN_MS

const isKind = (k: unknown): k is IdentityKind => k === 'key' || k === 'ip'

export type AppOptions = {
  // Host names to accept besides the built-in safe ones (see guard.ts).
  allowedHosts?: string[]
}

export function createApp(db: Db, collector: CliproxyCollector, prices: PriceBook, tailnet: Tailnet, options: AppOptions = {}) {
  const app = new Hono().basePath('/api')

  app.use('*', accessLog())
  app.use('*', requireKnownHost(options.allowedHosts ?? []))
  app.use('*', requireJsonWrites())

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    log('error', 'request failed', { method: c.req.method, path: c.req.path, ...errorFields(err) })
    return c.json({ error: 'Internal server error' }, 500)
  })
  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  // 503 once the collector has been down for a while, so the container
  // healthcheck (and any monitor) notices that usage is no longer recorded.
  app.get('/health', (c) =>
    c.json(
      {
        collector: collector.status,
        pricesLoadedAt: prices.loadedAt,
        tailnet: { syncedAt: tailnet.syncedAt, error: tailnet.lastError },
      },
      collectorDown(collector.status) ? 503 : 200,
    ),
  )

  // ?range=24h|7d|30d|90d|all&tz=<IANA time zone> (days are the viewer's local days).
  app.get('/usage', (c) => {
    const range = (c.req.query('range') ?? '30d') as Range
    if (!RANGES.includes(range)) return c.json({ error: `range must be one of ${RANGES.join(', ')}` }, 400)
    return c.json(usageSummary(db, range, validTimeZone(c.req.query('tz'))))
  })

  // Body: { files: [{ tool: 'claude-code' | 'codex', lines: string[] }] }, usage-only
  // transcript lines from another machine.
  app.post('/import', async (c) => {
    const { files } = await jsonBody(c)
    if (!Array.isArray(files)) return c.json({ error: 'files is required' }, 400)
    const valid: TranscriptFile[] = files.flatMap((f: unknown) => {
      if (!f || typeof f !== 'object') return []
      const { tool, lines } = f as Record<string, unknown>
      if ((tool !== 'claude-code' && tool !== 'codex') || !Array.isArray(lines)) return []
      return [{ tool, lines: lines.filter((l): l is string => typeof l === 'string') }]
    })
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    return c.json({ machineIp: clientIp, ...importTranscripts(db, prices, valid, clientIp) })
  })

  // Machines as seen by the proxy: proxy keys and client IPs, with names.
  app.get('/devices', (c) => c.json(listDevices(db)))

  // Body: { kind: 'key' | 'ip', value, name }. Identities with the same name are one machine.
  app.put('/devices/name', async (c) => {
    const { kind, value, name } = await jsonBody(c)
    if (!isKind(kind) || typeof value !== 'string' || !value || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'kind, value and name are required' }, 400)
    }
    nameIdentity(db, kind, value, name.trim())
    return c.json({ ok: true })
  })

  // Body: { kind, value }. Falls back to the Tailscale name or IP.
  app.delete('/devices/name', async (c) => {
    const { kind, value } = await jsonBody(c)
    if (!isKind(kind) || typeof value !== 'string' || !value) return c.json({ error: 'kind and value are required' }, 400)
    clearIdentityName(db, kind, value)
    return c.json({ ok: true })
  })

  return app
}

// The request body as a JSON object; anything else is a 400, not a crash.
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'Request body must be valid JSON' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTPException(400, { message: 'Request body must be a JSON object' })
  }
  return body as Record<string, unknown>
}

// Logs writes, rejected or failed requests, and slow ones; routine polling stays quiet.
function accessLog() {
  return async (c: Context, next: () => Promise<void>) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    const status = c.res.status
    if (c.req.method === 'GET' && status < 400 && ms < 1000) return
    log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
      method: c.req.method,
      path: c.req.path,
      status,
      ms,
    })
  }
}

function validTimeZone(tz: string | undefined) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}
