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
type Status = { Self?: StatusNode; Peer?: Record<string, StatusNode> }

export class Tailnet {
  syncedAt: number | null = null
  lastError: string | null = null

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

  async sync() {
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
  const proc = Bun.spawn([cli, 'status', '--json'], { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (proc.signalCode) throw new Error(`tailscale status timed out after ${timeoutMs / 1000}s`)
  if (code !== 0) throw new Error(`tailscale status exited with code ${code}`)
  const status: unknown = JSON.parse(text)
  if (!status || typeof status !== 'object') throw new Error('tailscale status returned unexpected output')
  return status as Status
}
