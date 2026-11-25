// Names machines from Tailscale: every tailnet IP maps to its device's
// MagicDNS name (e.g. 100.64.0.1 → "laptop").

import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import type { Db } from './db/client'
import { tailnetDevices } from './db/schema'

const REFRESH_EVERY_MS = 5 * 60e3
// A hung CLI (daemon not responding) is killed after this, so syncs can't pile up.
const STATUS_TIMEOUT_MS = 10e3
const LOOPBACK = ['127.0.0.1', '::1']

// launchd starts us with a minimal PATH, so look in the usual install spots.
const CLI_CANDIDATES = [
  process.env.TAILSCALE_BIN,
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
].filter(Boolean) as string[]

type StatusNode = { DNSName?: string; HostName?: string; OS?: string; TailscaleIPs?: string[]; Online?: boolean }
type Status = { BackendState?: string; Self?: StatusNode; Peer?: Record<string, StatusNode> }

export class Tailnet {
  syncedAt: number | null = null
  lastError: string | null = null
  private syncing: Promise<void> | null = null

  constructor(
    private db: Db,
    private statusTimeoutMs = STATUS_TIMEOUT_MS,
  ) {}

  start() {
    const run = () =>
      this.sync().catch((err: Error) => {
        this.lastError = err.message
        console.error(`[tailnet] sync failed: ${err.message}`)
      })
    void run()
    setInterval(run, REFRESH_EVERY_MS)
  }

  // One sync at a time: a call during a sync shares it.
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async syncOnce() {
    let status: Status
    try {
      status = await readStatus(this.statusTimeoutMs)
    } catch (err) {
      this.lastError = (err as Error).message
      // Keep the names from the last good sync rather than wiping them; only
      // seed loopback so local traffic is named even without Tailscale.
      this.db
        .insert(tailnetDevices)
        .values(loopbackRows(hostname().split('.')[0], new Date()))
        .onConflictDoNothing()
        .run()
      return
    }

    const now = new Date()
    const rows: (typeof tailnetDevices.$inferInsert)[] = []
    const add = (node: StatusNode, isSelf: boolean) => {
      const name = nameOf(node)
      for (const ip of node.TailscaleIPs ?? []) {
        rows.push({ ip, name, dnsName: node.DNSName ?? null, os: node.OS ?? null, isSelf, online: node.Online ?? null, syncedAt: now })
      }
    }
    if (status.Self) add(status.Self, true)
    for (const peer of Object.values(status.Peer ?? {})) add(peer, false)
    // Local requests get this machine's name too.
    rows.push(...loopbackRows(status.Self ? nameOf(status.Self) : hostname().split('.')[0], now))

    this.db.transaction((tx) => {
      tx.delete(tailnetDevices).run()
      tx.insert(tailnetDevices).values(rows).run()
    })
    this.syncedAt = now.getTime()
    this.lastError = null
  }
}

function loopbackRows(name: string, now: Date): (typeof tailnetDevices.$inferInsert)[] {
  return LOOPBACK.map((ip) => ({ ip, name, dnsName: null, os: null, isSelf: true, online: true, syncedAt: now }))
}

// iOS devices report HostName "localhost", so prefer the MagicDNS label.
function nameOf(node: StatusNode) {
  return node.DNSName?.split('.')[0] || node.HostName || 'unknown'
}

async function readStatus(timeoutMs: number): Promise<Status> {
  const cli = CLI_CANDIDATES.find((path) => existsSync(path))
  if (!cli) throw new Error('tailscale CLI not found')
  const text = await runBounded('tailscale status', [cli, 'status', '--json'], timeoutMs)
  const status: unknown = JSON.parse(text)
  if (!status || typeof status !== 'object') throw new Error('tailscale status returned unexpected output')
  // While logged out or starting, status still exits 0 but has no peer map;
  // treating that as "no devices" would wipe every name.
  const state = (status as Status).BackendState
  if (state !== 'Running') throw new Error(`tailscale is not running (state ${state ?? 'unknown'})`)
  return status as Status
}

// Runs a command and returns its stdout, failing after timeoutMs no matter
// what: the process is SIGKILLed (it can't ignore that) and the pipe is
// abandoned, in case something it started still holds it open.
async function runBounded(label: string, cmd: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const reader = proc.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reader.cancel().catch(() => {})
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
  })
  const run = async () => {
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const code = await proc.exited
    if (code !== 0) throw new Error(`${label} exited with code ${code}`)
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    return await Promise.race([run(), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
