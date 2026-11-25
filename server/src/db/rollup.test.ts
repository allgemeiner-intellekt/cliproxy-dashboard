// usage_rollup and usage_sessions must always equal a GROUP BY over
// requests, whichever way rows arrive, change or leave.

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { openDb } from './client'
import { rebuildRollup } from './rollup'
import { requests, usageRollup, usageSessions } from './schema'

type Db = ReturnType<typeof openDb>

const snapshot = (db: Db) => ({
  rollup: db.select().from(usageRollup).orderBy(usageRollup.slot, usageRollup.model, usageRollup.clientIp).all(),
  sessions: db.select().from(usageSessions).orderBy(usageSessions.sessionId, usageSessions.model).all(),
})

// What the triggers maintain must equal a rebuild from scratch.
function expectConsistent(db: Db) {
  const maintained = snapshot(db)
  rebuildRollup(db.$client)
  expect(maintained).toEqual(snapshot(db))
}

let n = 0
const row = (overrides: Partial<typeof requests.$inferInsert> = {}): typeof requests.$inferInsert => ({
  id: `r${n++}`,
  source: 'cliproxy',
  occurredAt: new Date(Date.UTC(2026, 0, 1, 10, 5)),
  receivedAt: new Date(),
  provider: 'codex',
  model: 'gpt-6.1-sol',
  failed: false,
  inputTokens: 100,
  cacheReadTokens: 50,
  outputTokens: 10,
  costMicros: 1000,
  cacheSavingsMicros: 20,
  ...overrides,
})

describe('usage rollup triggers', () => {
  test('inserts aggregate into 15-minute slots, NULLs as the NUL key', () => {
    const db = openDb(':memory:')
    db.insert(requests)
      .values([
        row({ occurredAt: new Date(Date.UTC(2026, 0, 1, 10, 0)), clientIp: '10.0.0.1' }),
        row({ occurredAt: new Date(Date.UTC(2026, 0, 1, 10, 14, 59)), clientIp: '10.0.0.1', costMicros: null, inputTokens: null }),
        row({ occurredAt: new Date(Date.UTC(2026, 0, 1, 10, 15)), clientIp: '10.0.0.1' }),
      ])
      .run()
    const { rollup } = snapshot(db)
    expect(rollup).toHaveLength(2)
    expect(rollup[0]).toMatchObject({
      slot: Date.UTC(2026, 0, 1, 10, 0),
      accountLabel: '\u0000',
      clientKeyHash: '\u0000',
      clientIp: '10.0.0.1',
      records: 2,
      unpricedRecords: 1,
      costMicros: 1000,
      inputTokens: 100,
      cacheReadTokens: 100,
    })
    expect(rollup[1]).toMatchObject({ slot: Date.UTC(2026, 0, 1, 10, 15), records: 1 })
    expectConsistent(db)
  })

  test('ignored duplicate inserts are not counted', () => {
    const db = openDb(':memory:')
    const r = row()
    db.insert(requests).values(r).run()
    db.insert(requests).values(r).onConflictDoNothing().run()
    expect(snapshot(db).rollup[0].records).toBe(1)
    expectConsistent(db)
  })

  test('repricing updates move the totals', () => {
    const db = openDb(':memory:')
    db.insert(requests).values(row({ id: 'x', costMicros: null, cacheSavingsMicros: null })).run()
    expect(snapshot(db).rollup[0]).toMatchObject({ unpricedRecords: 1, costMicros: 0 })
    db.update(requests).set({ costMicros: 5000, cacheSavingsMicros: 7 }).where(sql`id = 'x'`).run()
    expect(snapshot(db).rollup[0]).toMatchObject({ unpricedRecords: 0, costMicros: 5000, cacheSavingsMicros: 7, records: 1 })
    expectConsistent(db)
  })

  test('updates that change the key move the row between slots and keys', () => {
    const db = openDb(':memory:')
    db.insert(requests).values([row({ id: 'a' }), row({ id: 'b' })]).run()
    db.update(requests).set({ occurredAt: new Date(Date.UTC(2026, 0, 2)), model: 'other', clientIp: '1.2.3.4' }).where(sql`id = 'a'`).run()
    expect(snapshot(db).rollup.map((r) => [r.model, r.records])).toEqual([
      ['gpt-6.1-sol', 1],
      ['other', 1],
    ])
    expectConsistent(db)
  })

  test('deletes subtract, and empty groups disappear', () => {
    const db = openDb(':memory:')
    db.insert(requests).values([row({ id: 'a' }), row({ id: 'b', model: 'solo' })]).run()
    db.delete(requests).where(sql`id IN ('a', 'b')`).run()
    expect(snapshot(db).rollup).toEqual([])
    expectConsistent(db)
  })

  test('sessions track the last request per session and model', () => {
    const db = openDb(':memory:')
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h))
    db.insert(requests)
      .values([
        row({ id: 's1', sessionId: 'S', tool: 'codex', occurredAt: at(1) }),
        row({ id: 's2', sessionId: 'S', tool: 'codex', occurredAt: at(3) }),
        row({ id: 's3', sessionId: 'S', tool: 'codex', occurredAt: at(2) }),
        row({ id: 'n1', sessionId: null, occurredAt: at(4) }),
        row({ id: 't1', sessionId: 'T', tool: null, occurredAt: at(5) }),
      ])
      .run()
    expect(snapshot(db).sessions.map((s) => [s.tool, s.sessionId, s.lastAt])).toEqual([
      ['codex', 'S', at(3).getTime()],
      ['other', 'T', at(5).getTime()],
    ])
    // Removing the latest request falls back to the next latest.
    db.delete(requests).where(sql`id = 's2'`).run()
    expect(snapshot(db).sessions[0].lastAt).toBe(at(2).getTime())
    // Removing a session's last request removes the session.
    db.delete(requests).where(sql`id = 't1'`).run()
    expect(snapshot(db).sessions.map((s) => s.sessionId)).toEqual(['S'])
    expectConsistent(db)
  })

  test('INSERT OR REPLACE moves the replaced row out of its slot and session', () => {
    const db = openDb(':memory:')
    db.insert(requests).values(row({ id: 'x', sessionId: 'A', occurredAt: new Date(Date.UTC(2026, 0, 1, 1)) })).run()
    db.$client.exec(
      `INSERT OR REPLACE INTO requests (id, source, occurred_at, received_at, provider, model, failed, session_id)
       VALUES ('x', 'cliproxy', ${Date.UTC(2026, 0, 2)}, 0, 'codex', 'gpt-6.1-sol', 0, 'B')`,
    )
    const { rollup, sessions } = snapshot(db)
    expect(rollup.map((r) => [r.slot, r.records])).toEqual([[Date.UTC(2026, 0, 2), 1]])
    expect(sessions.map((x) => x.sessionId)).toEqual(['B'])
    expectConsistent(db)
  })

  test("a real '' is kept apart from NULL", () => {
    const db = openDb(':memory:')
    db.insert(requests).values([row({ accountLabel: '', clientIp: '' }), row({ accountLabel: null, clientIp: null })]).run()
    expect(snapshot(db).rollup).toHaveLength(2)
    expectConsistent(db)
  })

  test('a randomized mix of writes stays consistent', () => {
    const db = openDb(':memory:')
    let seed = 7
    const rand = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % k)
    for (let i = 0; i < 400; i++) {
      const op = rand(10)
      if (op < 6) {
        db.insert(requests)
          .values(
            row({
              id: `m${rand(150)}`,
              occurredAt: new Date(Date.UTC(2026, 0, 1) + rand(48) * 600e3),
              model: ['a', 'b', 'c'][rand(3)],
              clientIp: rand(2) ? '10.0.0.1' : null,
              accountLabel: rand(2) ? 'acct' : null,
              sessionId: rand(3) ? `s${rand(5)}` : null,
              costMicros: rand(4) ? rand(1000) : null,
            }),
          )
          .onConflictDoNothing()
          .run()
      } else if (op < 8) {
        db.update(requests).set({ costMicros: rand(1000), model: ['a', 'b', 'c'][rand(3)] }).where(sql`id = ${`m${rand(150)}`}`).run()
      } else {
        db.delete(requests).where(sql`id = ${`m${rand(150)}`}`).run()
      }
    }
    expect(snapshot(db).rollup.length).toBeGreaterThan(0)
    expectConsistent(db)
  })
})

describe('ensureRollup', () => {
  test('rebuilds on open when the rollup misses rows (e.g. the first start after upgrading)', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const dir = mkdtempSync(`${require('node:os').tmpdir()}/rollup-test-`)
    try {
      const path = `${dir}/usage.db`
      const db = openDb(path)
      db.insert(requests).values([row({ sessionId: 'S' }), row()]).run()
      // Simulate rows written without the triggers.
      db.$client.exec('DELETE FROM usage_rollup; DELETE FROM usage_sessions;')
      db.$client.close()

      const reopened = openDb(path)
      expect(reopened.select({ n: sql<number>`sum(records)` }).from(usageRollup).get()?.n).toBe(2)
      expect(reopened.select().from(usageSessions).all()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing or altered trigger is reinstalled and the tables rebuilt', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const dir = mkdtempSync(`${require('node:os').tmpdir()}/rollup-test-`)
    try {
      const path = `${dir}/usage.db`
      const db = openDb(path)
      db.insert(requests).values(row({ id: 'x', sessionId: 'S', model: 'old' })).run()
      // Updates made while the update triggers were missing: counts still match.
      db.$client.exec('DROP TRIGGER usage_rollup_update; DROP TRIGGER usage_sessions_update')
      db.$client.exec("UPDATE requests SET model = 'new', cost_micros = 9, session_id = 'T' WHERE id = 'x'")
      db.$client.close()

      const reopened = openDb(path)
      const { rollup, sessions } = snapshot(reopened)
      expect(rollup.map((r) => [r.model, r.costMicros])).toEqual([['new', 9]])
      expect(sessions.map((x) => x.sessionId)).toEqual(['T'])
      const triggers = reopened.$client.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }
      expect(triggers.n).toBe(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the tables PR #2 left behind are gone', () => {
    const db = openDb(':memory:')
    const tables = (db.$client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    for (const gone of ['key_labels', 'pool_peers', 'pool_sharing', 'settings', 'price_overrides']) expect(tables).not.toContain(gone)
    expect(tables).toContain('usage_rollup')
  })
})
