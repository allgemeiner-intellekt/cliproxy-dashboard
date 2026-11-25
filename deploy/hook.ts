// Deploy receiver: CI asks it to redeploy a TrueNAS app after publishing an image.
//
//   POST /deploy            {"app": "<name>"}  signed, returns 202 {"job": <id>}
//   GET  /deploy/jobs/:id   signed, state of a job this receiver started
//
// Requests are signed with HMAC-SHA256 using DEPLOY_SECRET, sent as
// X-Deploy-Timestamp (unix seconds) and X-Deploy-Signature (hex):
//   POST: over `${timestamp}.${body}`
//   GET:  over `${timestamp}.job ${id}`, e.g. `1790000000.job 7`
// The timestamp must be within 5 minutes. Each POST signature is accepted
// once, so a captured request can't be replayed inside that window. Used
// signatures live in memory, so POSTs signed before this process started are
// refused too: a restart can't reopen the window for an earlier request.
// Only apps listed in DEPLOY_APPS can be redeployed. The TrueNAS key
// (DEPLOY_TRUENAS_KEY_FILE) never leaves this machine.
//
// TrueNAS is driven over its JSON-RPC websocket on loopback: on 25.10 the REST API
// answers 403 to a role-scoped API key that JSON-RPC accepts.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAX_SKEW_S = 300
const MAX_BODY_BYTES = 4096
const MAX_JOBS = 100
const MAX_SIGNATURES = 10_000
const startedAt = Math.floor(Date.now() / 1000)
const secret = required('DEPLOY_SECRET')
const apps = new Set(required('DEPLOY_APPS').split(',').map((a) => a.trim()))
const truenasKey = readFileSync(required('DEPLOY_TRUENAS_KEY_FILE'), 'utf8').trim()
const truenas = process.env.DEPLOY_TRUENAS_URL ?? 'ws://127.0.0.1/api/current'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function signed(req: Request, payload: string) {
  const timestamp = req.headers.get('x-deploy-timestamp') ?? ''
  const signature = req.headers.get('x-deploy-signature') ?? ''
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > MAX_SKEW_S) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest()
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected)
}

// POST signatures seen within the skew window, with when they stop being valid.
const usedSignatures = new Map<string, number>()

// 'ok', or why this signed POST can't be accepted. Never evicts a live entry:
// at capacity it refuses instead.
function firstUse(req: Request): 'ok' | 'replay' | 'busy' {
  const now = Date.now() / 1000
  const timestamp = Number(req.headers.get('x-deploy-timestamp'))
  if (timestamp < startedAt) return 'replay'
  for (const [sig, expires] of usedSignatures) if (expires < now) usedSignatures.delete(sig)
  const signature = req.headers.get('x-deploy-signature')!.toLowerCase()
  if (usedSignatures.has(signature)) return 'replay'
  if (usedSignatures.size >= MAX_SIGNATURES) return 'busy'
  usedSignatures.set(signature, timestamp + MAX_SKEW_S + 1)
  return 'ok'
}

function appFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown
    const app = typeof parsed === 'object' && parsed !== null ? (parsed as { app?: unknown }).app : undefined
    return typeof app === 'string' ? app : null
  } catch {
    return null
  }
}

// A logged-in JSON-RPC session. TrueNAS only shows a job to the session that
// started it, so the session that starts a redeploy also waits for it.
async function session() {
  const ws = new WebSocket(truenas)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message?: string; data?: { reason?: string } } }
    const waiter = msg.id === undefined ? undefined : pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id!)
    if (msg.error) waiter.reject(new Error(msg.error.data?.reason ?? msg.error.message ?? 'TrueNAS error'))
    else waiter.resolve(msg.result)
  }
  ws.onclose = () => {
    for (const w of pending.values()) w.reject(new Error('TrueNAS connection closed'))
    pending.clear()
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('Cannot reach TrueNAS'))
  })
  const call = (method: string, params: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  if ((await call('auth.login_with_api_key', [truenasKey])) !== true) {
    ws.close()
    throw new Error('TrueNAS rejected the API key')
  }
  return { call, close: () => ws.close() }
}

type JobState = { state: 'RUNNING' | 'SUCCESS' | 'FAILED'; error: string | null }
const jobs = new Map<number, JobState>()

function startTracking(job: number) {
  jobs.set(job, { state: 'RUNNING', error: null })
  // Maps iterate in insertion order: drop the oldest.
  for (const id of jobs.keys()) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(id)
  }
}

// Updates in place (keeping its age), and only if the job is still tracked.
function finish(job: number, state: JobState) {
  if (jobs.has(job)) jobs.set(job, state)
}

async function redeploy(app: string) {
  const s = await session()
  try {
    const job = Number(await s.call('app.redeploy', [app]))
    startTracking(job)
    s.call('core.job_wait', [job])
      .then(() => finish(job, { state: 'SUCCESS', error: null }))
      .catch((err: Error) => finish(job, { state: 'FAILED', error: err.message }))
      .finally(s.close)
    return job
  } catch (err) {
    s.close()
    throw err
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.DEPLOY_PORT ?? 30091),
  maxRequestBodySize: MAX_BODY_BYTES,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/deploy') {
      const body = await req.text()
      if (!signed(req, body)) return Response.json({ error: 'bad signature' }, { status: 401 })
      const use = firstUse(req)
      if (use === 'replay') return Response.json({ error: 'signature already used' }, { status: 409 })
      if (use === 'busy') return Response.json({ error: 'too many recent deploy requests' }, { status: 503 })
      const app = appFrom(body)
      if (app === null) return Response.json({ error: 'body must be {"app": "<name>"}' }, { status: 400 })
      if (!apps.has(app)) return Response.json({ error: `${app} is not deployable` }, { status: 403 })
      let job: number
      try {
        job = await redeploy(app)
      } catch (err) {
        console.warn(`[deploy] ${app}: ${(err as Error).message}`)
        return Response.json({ error: (err as Error).message }, { status: 502 })
      }
      console.log(`[deploy] ${app}: job ${job}`)
      return Response.json({ job }, { status: 202 })
    }

    const match = url.pathname.match(/^\/deploy\/jobs\/(\d+)$/)
    if (req.method === 'GET' && match) {
      // Job errors come from TrueNAS, so only signed callers see them.
      // no-store: a shared cache in front must not hand a signed answer to an
      // unsigned request for the same URL.
      const headers = { 'Cache-Control': 'no-store' }
      if (!signed(req, `job ${match[1]}`)) return Response.json({ error: 'bad signature' }, { status: 401, headers })
      const job = jobs.get(Number(match[1]))
      return job ? Response.json(job, { headers }) : Response.json({ error: 'not found' }, { status: 404, headers })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
console.log(`[deploy] listening on ${server.port}`)
