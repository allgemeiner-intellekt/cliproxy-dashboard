// Machine naming: which name each identity shows, and how renames group
// identities into one machine.

import { describe, expect, test } from 'bun:test'
import { openDb } from './db/client'
import { machineIdentities, machines, requests, tailnetDevices } from './db/schema'
import { clearIdentityName, listDevices, nameIdentity } from './machines'

function setup() {
  const db = openDb(':memory:')
  let n = 0
  const request = (overrides: Partial<typeof requests.$inferInsert>) =>
    db
      .insert(requests)
      .values({
        id: String(n++),
        source: 'cliproxy',
        occurredAt: new Date(Date.UTC(2025, 0, 1, 0, n)),
        receivedAt: new Date(),
        provider: 'openai',
        model: 'm',
        failed: false,
        costMicros: 100,
        ...overrides,
      })
      .run()
  return { db, request }
}

const tailnet = (db: ReturnType<typeof openDb>, ip: string, name: string) =>
  db.insert(tailnetDevices).values({ ip, name, dnsName: `${name}.ts.net.`, os: 'linux', isSelf: false, online: true, syncedAt: new Date() }).run()

const find = (db: ReturnType<typeof openDb>, kind: string, value: string) => listDevices(db).find((d) => d.kind === kind && d.value === value)

describe('listDevices', () => {
  test('lists every key and IP with activity, most recent first', () => {
    const { db, request } = setup()
    request({ clientIp: '10.0.0.1', clientKeyHash: 'k1' })
    request({ clientIp: '10.0.0.1', clientKeyHash: 'k1', userAgent: 'codex' })
    request({ clientIp: '10.0.0.2' })
    const devices = listDevices(db)
    expect(devices.map((d) => `${d.kind}:${d.value}`)).toEqual(['ip:10.0.0.2', 'key:k1', 'ip:10.0.0.1'])
    expect(find(db, 'key', 'k1')).toMatchObject({ requests: 2, costMicros: 200, userAgent: 'codex', name: null, nameSource: null })
  })

  test('a custom name beats the Tailscale name, which beats nothing', () => {
    const { db, request } = setup()
    request({ clientIp: '100.64.0.1' })
    request({ clientIp: '100.64.0.2' })
    tailnet(db, '100.64.0.1', 'laptop')
    tailnet(db, '100.64.0.2', 'phone')
    nameIdentity(db, 'ip', '100.64.0.2', 'My Phone')
    expect(find(db, 'ip', '100.64.0.1')).toMatchObject({ name: 'laptop', nameSource: 'tailscale', tailscale: { name: 'laptop', os: 'linux' } })
    expect(find(db, 'ip', '100.64.0.2')).toMatchObject({ name: 'My Phone', nameSource: 'custom' })
  })

  test('named identities show up even before they send requests', () => {
    const { db } = setup()
    nameIdentity(db, 'key', 'unused-key', 'Build box')
    expect(find(db, 'key', 'unused-key')).toMatchObject({ name: 'Build box', requests: 0, lastSeen: null })
  })
})

describe('nameIdentity / clearIdentityName', () => {
  test('identities given the same name become one machine', () => {
    const { db } = setup()
    nameIdentity(db, 'ip', '10.0.0.1', 'desk')
    nameIdentity(db, 'key', 'k1', 'desk')
    expect(db.select().from(machines).all()).toHaveLength(1)
    expect(db.select().from(machineIdentities).all()).toHaveLength(2)
  })

  test('renaming moves the identity and removes the emptied machine', () => {
    const { db } = setup()
    nameIdentity(db, 'ip', '10.0.0.1', 'old')
    nameIdentity(db, 'ip', '10.0.0.1', 'new')
    expect(db.select().from(machines).all().map((m) => m.name)).toEqual(['new'])
    expect(find(db, 'ip', '10.0.0.1')?.name).toBe('new')
  })

  test('clearing falls back to the Tailscale name and drops unused machines', () => {
    const { db, request } = setup()
    request({ clientIp: '100.64.0.1' })
    tailnet(db, '100.64.0.1', 'laptop')
    nameIdentity(db, 'ip', '100.64.0.1', 'Work laptop')
    clearIdentityName(db, 'ip', '100.64.0.1')
    expect(find(db, 'ip', '100.64.0.1')).toMatchObject({ name: 'laptop', nameSource: 'tailscale' })
    expect(db.select().from(machines).all()).toHaveLength(0)
  })

  test('clearing one identity keeps the machine for the others', () => {
    const { db } = setup()
    nameIdentity(db, 'ip', '10.0.0.1', 'desk')
    nameIdentity(db, 'key', 'k1', 'desk')
    clearIdentityName(db, 'ip', '10.0.0.1')
    expect(db.select().from(machines).all()).toHaveLength(1)
    expect(find(db, 'key', 'k1')?.name).toBe('desk')
  })
})
