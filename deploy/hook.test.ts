import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'test-secret'
const BODY = '{"app":"cliproxy-dashboard"}'
let base = ''
let hook: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>
let truenas: ReturnType<typeof Bun.serve>

// A fake TrueNAS JSON-RPC websocket. Each app.redeploy starts a new job, and
// core.job_wait answers only when the test calls finishJob().
let nextJob = 1
const waits = new Map<number, (error?: string) => void>()
const finishJob = (job: number, error?: string) => waits.get(job)!(error)

beforeAll(async () => {
  truenas = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, server) => (server.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, raw) {
        const { id, method, params } = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] }
        const reply = (msg: object) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...msg }))
        if (method === 'auth.login_with_api_key') reply({ result: true })
        else if (method === 'app.redeploy') reply({ result: nextJob++ })
        else if (method === 'core.job_wait') {
          waits.set(Number(params[0]), (error) => reply(error ? { error: { message: error } } : { result: null }))
        }
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
      DEPLOY_PORT: '0',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  // The hook prints the port the kernel gave it once it's listening.
  const decoder = new TextDecoder()
  let out = ''
  for await (const chunk of hook.stdout) {
    out += decoder.decode(chunk)
    const port = out.match(/listening on (\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      return
    }
  }
  throw new Error(`hook exited before listening: ${out}`)
})

afterAll(() => {
  hook?.kill()
  truenas?.stop(true)
})

const now = () => Math.floor(Date.now() / 1000)
const sign = (payload: string, ts = now()) => ({
  'X-Deploy-Timestamp': String(ts),
  'X-Deploy-Signature': createHmac('sha256', SECRET).update(`${ts}.${payload}`).digest('hex'),
})
const deploy = (body: string, headers: Record<string, string> = sign(body)) =>
  fetch(`${base}/deploy`, { method: 'POST', body, headers })
const status = (job: number, headers: Record<string, string> = sign(`job ${job}`)) =>
  fetch(`${base}/deploy/jobs/${job}`, { headers })
// Same body and second means the same signature, so vary the body.
let nonce = 0
const startJob = async () => {
  const res = await deploy(JSON.stringify({ app: 'cliproxy-dashboard', nonce: nonce++ }))
  expect(res.status).toBe(202)
  return ((await res.json()) as { job: number }).job
}
const settled = async (job: number, state: string) => {
  for (let i = 0; i < 100; i++) {
    const body = (await (await status(job)).json()) as { state: string; error: string | null }
    if (body.state === state) return body
    await Bun.sleep(10)
  }
  throw new Error(`job ${job} never reached ${state}`)
}
const waitForWait = async (job: number) => {
  for (let i = 0; i < 100 && !waits.has(job); i++) await Bun.sleep(10)
}

describe('deploy hook', () => {
  test('a signed request starts a job, and the same request is not accepted twice', async () => {
    const headers = sign(BODY)
    expect((await deploy(BODY, headers)).status).toBe(202)
    const jobsBefore = nextJob
    expect((await deploy(BODY, headers)).status).toBe(409)
    expect(nextJob).toBe(jobsBefore)
  })

  test('refuses requests signed before the hook started', async () => {
    expect((await deploy(BODY, sign(BODY, now() - 60))).status).toBe(409)
  })

  test('rejects bad, stale and missing signatures', async () => {
    expect((await deploy(BODY, { ...sign(BODY), 'X-Deploy-Signature': '00'.repeat(32) })).status).toBe(401)
    expect((await deploy(BODY, sign(BODY, now() - 301))).status).toBe(401)
    expect((await deploy(BODY, {})).status).toBe(401)
  })

  test('rejects a signed body that is not {"app": "<name>"}', async () => {
    for (const body of ['not json', 'null', '[]', '{"app":1}', '{}']) expect((await deploy(body)).status).toBe(400)
    expect((await deploy('{"app":"other"}')).status).toBe(403)
  })

  test('job status needs a signature for that job and is never cached', async () => {
    const job = await startJob()
    expect((await status(job, {})).status).toBe(401)
    expect((await status(job, sign(`job ${job + 1}`))).status).toBe(401)

    const running = await status(job)
    expect(running.headers.get('cache-control')).toBe('no-store')
    expect(await running.json()).toEqual({ state: 'RUNNING', error: null })

    await waitForWait(job)
    finishJob(job)
    expect(await settled(job, 'SUCCESS')).toEqual({ state: 'SUCCESS', error: null })
    expect((await status(9999)).status).toBe(404)
  })

  test('reports a failed job', async () => {
    const job = await startJob()
    await waitForWait(job)
    finishJob(job, 'image pull failed')
    expect(await settled(job, 'FAILED')).toEqual({ state: 'FAILED', error: 'image pull failed' })
  })

  test('rejects oversized bodies', async () => {
    expect((await deploy(JSON.stringify({ app: 'x'.repeat(5000) }))).status).toBe(413)
  })
})
