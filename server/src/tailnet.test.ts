import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/client'
import { tailnetDevices } from './db/schema'
import { Tailnet } from './tailnet'

// A stand-in `tailscale` CLI whose behaviour each test picks with mode().
const dir = mkdtempSync(join(tmpdir(), 'tailnet-test-'))
const statusFile = join(dir, 'status.json')
const modeFile = join(dir, 'mode')
const cli = join(dir, 'tailscale')
const pidFile = join(dir, 'child.pid')
const mode = (m: 'ok' | 'fail' | 'hang' | 'stubborn' | 'wrapper') => writeFileSync(modeFile, m)
writeFileSync(
  cli,
  `#!/bin/sh
case "$(cat "${modeFile}")" in
  ok) cat "${statusFile}" ;;
  fail) exit 1 ;;
  hang) exec sleep 30 ;;
  # Ignores SIGTERM and leaves a child holding stdout open.
  stubborn) trap '' TERM; sleep 3 & wait ;;
  # A wrapper that runs the real CLI without exec; the CLI hangs.
  wrapper) sleep 30 & echo $! > "${pidFile}"; wait ;;
esac
`,
)
chmodSync(cli, 0o755)
const make = (db: ReturnType<typeof openDb>, timeoutMs?: number) => new Tailnet(db, { cli, timeoutMs })

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const STATUS = {
  BackendState: 'Running',
  Self: { DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', TailscaleIPs: ['100.64.0.1'], Online: true },
  Peer: { a: { DNSName: 'phone.tail1234.ts.net.', HostName: 'localhost', TailscaleIPs: ['100.64.0.2'], Online: false } },
}

function names(db: ReturnType<typeof openDb>) {
  return Object.fromEntries(db.select().from(tailnetDevices).all().map((d) => [d.ip, d.name]))
}

describe('Tailnet.sync', () => {
  beforeEach(() => writeFileSync(statusFile, JSON.stringify(STATUS)))

  test('names tailnet IPs and loopback from tailscale status', async () => {
    mode('ok')
    const db = openDb(':memory:')
    const tailnet = make(db)
    await tailnet.sync()
    expect(names(db)).toEqual({ '100.64.0.1': 'laptop', '100.64.0.2': 'phone', '127.0.0.1': 'laptop', '::1': 'laptop' })
    expect(tailnet.syncedAt).not.toBeNull()
    expect(tailnet.lastError).toBeNull()
  })

  test('a failed read keeps the last good names', async () => {
    const db = openDb(':memory:')
    const tailnet = make(db)
    mode('ok')
    await tailnet.sync()
    const before = names(db)

    mode('fail')
    await tailnet.sync()
    expect(names(db)).toEqual(before)
    expect(tailnet.lastError).toContain('exited with code 1')
  })

  test('without any good sync, loopback still gets a name', async () => {
    mode('fail')
    const db = openDb(':memory:')
    await make(db).sync()
    expect(Object.keys(names(db)).sort()).toEqual(['127.0.0.1', '::1'])
  })

  test('a hung CLI is killed after the timeout', async () => {
    mode('hang')
    const db = openDb(':memory:')
    const tailnet = make(db, 200)
    const started = Date.now()
    await tailnet.sync()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(tailnet.lastError).toContain('timed out')
  })

  test('a stubborn CLI that ignores SIGTERM and leaks its stdout still times out', async () => {
    mode('stubborn')
    const tailnet = make(openDb(':memory:'), 200)
    const started = Date.now()
    await tailnet.sync()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(tailnet.lastError).toContain('timed out')
  })

  test('a timeout kills the whole process group, not just a wrapper', async () => {
    mode('wrapper')
    const tailnet = make(openDb(':memory:'), 200)
    await tailnet.sync()
    expect(tailnet.lastError).toContain('timed out')
    const child = Number(readFileSync(pidFile, 'utf8'))
    await Bun.sleep(50)
    expect(() => process.kill(child, 0)).toThrow()
  })

  test('a malformed snapshot keeps the last good names', async () => {
    const db = openDb(':memory:')
    const tailnet = make(db)
    mode('ok')
    await tailnet.sync()
    const before = names(db)
    for (const bad of [
      { BackendState: 'Running', Self: STATUS.Self, Peer: false },
      { BackendState: 'Running', Self: STATUS.Self, Peer: { a: null } },
      { BackendState: 'Running', Self: { ...STATUS.Self, TailscaleIPs: '100.64.0.1' } },
      { BackendState: 'Running' },
    ]) {
      writeFileSync(statusFile, JSON.stringify(bad))
      await tailnet.sync()
      expect(names(db)).toEqual(before)
      expect(tailnet.lastError).toContain('unexpected output')
    }
  })

  test('a logged-out backend keeps the last good names', async () => {
    const db = openDb(':memory:')
    const tailnet = make(db)
    mode('ok')
    await tailnet.sync()
    const before = names(db)

    // What `tailscale status --json` prints, exit 0, while logged out.
    writeFileSync(statusFile, JSON.stringify({ BackendState: 'NeedsLogin', Self: { HostName: 'laptop', TailscaleIPs: [] } }))
    await tailnet.sync()
    expect(names(db)).toEqual(before)
    expect(tailnet.lastError).toContain('NeedsLogin')
  })

  test('a running tailnet with no peers is a good sync', async () => {
    mode('ok')
    writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: STATUS.Self }))
    const db = openDb(':memory:')
    const tailnet = make(db)
    await tailnet.sync()
    expect(names(db)['100.64.0.1']).toBe('laptop')
    expect(tailnet.lastError).toBeNull()
  })

  test('overlapping syncs share one CLI run', async () => {
    mode('ok')
    const tailnet = make(openDb(':memory:'))
    const a = tailnet.sync()
    expect(tailnet.sync()).toBe(a)
    await a
  })

  test('removed devices drop out on the next good sync', async () => {
    mode('ok')
    const db = openDb(':memory:')
    const tailnet = make(db)
    await tailnet.sync()
    writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: STATUS.Self }))
    await tailnet.sync()
    expect(names(db)['100.64.0.2']).toBeUndefined()
  })
})
