import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/client'
import { tailnetDevices } from './db/schema'

// A stand-in `tailscale` CLI whose behaviour each test picks with mode().
const dir = mkdtempSync(join(tmpdir(), 'tailnet-test-'))
const statusFile = join(dir, 'status.json')
const modeFile = join(dir, 'mode')
const cli = join(dir, 'tailscale')
const mode = (m: 'ok' | 'fail' | 'hang') => writeFileSync(modeFile, m)
writeFileSync(
  cli,
  `#!/bin/sh
case "$(cat "${modeFile}")" in
  ok) cat "${statusFile}" ;;
  fail) exit 1 ;;
  hang) exec sleep 30 ;;
esac
`,
)
chmodSync(cli, 0o755)
process.env.TAILSCALE_BIN = cli
const { Tailnet } = await import('./tailnet')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const STATUS = {
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
    const tailnet = new Tailnet(db)
    await tailnet.sync()
    expect(names(db)).toEqual({ '100.64.0.1': 'laptop', '100.64.0.2': 'phone', '127.0.0.1': 'laptop', '::1': 'laptop' })
    expect(tailnet.syncedAt).not.toBeNull()
    expect(tailnet.lastError).toBeNull()
  })

  test('a failed read keeps the last good names', async () => {
    const db = openDb(':memory:')
    const tailnet = new Tailnet(db)
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
    await new Tailnet(db).sync()
    expect(Object.keys(names(db)).sort()).toEqual(['127.0.0.1', '::1'])
  })

  test('a hung CLI is killed after the timeout', async () => {
    mode('hang')
    const db = openDb(':memory:')
    const tailnet = new Tailnet(db, 200)
    const started = Date.now()
    await tailnet.sync()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(tailnet.lastError).toContain('timed out')
  })

  test('removed devices drop out on the next good sync', async () => {
    mode('ok')
    const db = openDb(':memory:')
    const tailnet = new Tailnet(db)
    await tailnet.sync()
    writeFileSync(statusFile, JSON.stringify({ Self: STATUS.Self }))
    await tailnet.sync()
    expect(names(db)['100.64.0.2']).toBeUndefined()
  })
})
