import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'test-secret'
const port = 40000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
let hook: ReturnType<typeof Bun.spawn>
let truenas: ReturnType<typeof Bun.serve>
let redeploys = 0

// A fake TrueNAS JSON-RPC websocket: accepts the key, starts job 7, and
// finishes it straight away.
beforeAll(async () => {
  truenas = Bun.serve({
    port: 0,
    fetch: (req, server) => (server.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, raw) {
        const { id, method } = JSON.parse(String(raw)) as { id: number; method: string }
        if (method === 'app.redeploy') redeploys++
        const result = method === 'auth.login_with_api_key' ? true : method === 'app.redeploy' ? 7 : null
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      },
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'))
  writeFileSync(join(dir, 'key'), 'truenas-key')
  hook = Bun.spawn([process.execPath, new URL('./hook.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      DEPLOY_SECRET: SECRET,
      DEPLOY_APPS: 'cliproxy-dashboard',
      DEPLOY_TRUENAS_KEY_FILE: join(dir, 'key'),
      DEPLOY_TRUENAS_URL: `ws://127.0.0.1:${truenas.port}`,
      DEPLOY_PORT: String(port),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(() => true, () => false)) return
    await Bun.sleep(50)
  }
  throw new Error('hook did not start')
})

afterAll(() => {
  hook?.kill()
  truenas?.stop(true)
})

const sign = (payload: string, ts = Math.floor(Date.now() / 1000)) => ({
  'X-Deploy-Timestamp': String(ts),
  'X-Deploy-Signature': createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex'),
})
const deploy = (body: string, headers = sign(body)) => fetch(`${base}/deploy`, { method: 'POST', body, headers })

describe('deploy hook', () => {
  test('a signed request starts a job, and the same request is not accepted twice', async () => {
    const body = '{"app":"cliproxy-dashboard"}'
    const headers = sign(body)
    const first = await deploy(body, headers)
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ job: 7 })
    const replay = await deploy(body, headers)
    expect(replay.status).toBe(409)
    expect(redeploys).toBe(1)
  })

  test('rejects bad, stale and missing signatures', async () => {
    const body = '{"app":"cliproxy-dashboard"}'
    expect((await deploy(body, { ...sign(body), 'X-Deploy-Signature': '00'.repeat(32) })).status).toBe(401)
    expect((await deploy(body, sign(body, Math.floor(Date.now() / 1000) - 301))).status).toBe(401)
    expect((await deploy(body, {} as ReturnType<typeof sign>)).status).toBe(401)
  })

  test('rejects a signed body that is not {"app": "<name>"}', async () => {
    for (const body of ['not json', 'null', '[]', '{"app":1}', '{}']) {
      expect((await deploy(body)).status).toBe(400)
    }
    expect((await deploy('{"app":"other"}')).status).toBe(403)
  })

  test('job status needs a signature for that job', async () => {
    expect((await fetch(`${base}/deploy/jobs/7`)).status).toBe(401)
    expect((await fetch(`${base}/deploy/jobs/7`, { headers: sign('job 8') })).status).toBe(401)
    const res = await fetch(`${base}/deploy/jobs/7`, { headers: sign('job 7') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'SUCCESS', error: null })
    expect((await fetch(`${base}/deploy/jobs/9`, { headers: sign('job 9') })).status).toBe(404)
  })

  test('rejects oversized bodies', async () => {
    const body = JSON.stringify({ app: 'x'.repeat(5000) })
    expect((await deploy(body)).status).toBe(413)
  })
})
