import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, pruneBackups } from './backup'
import { openDb } from './db/client'
import { requests } from './db/schema'

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const row = (id: string) => ({ id, source: 'cliproxy', occurredAt: new Date(), receivedAt: new Date(), provider: 'p', model: 'm', failed: false })

describe('backupDatabase (E10)', () => {
  test('snapshots everything, including writes still in the WAL, owner-only', () =>
    withDir((dir) => {
      const path = join(dir, 'usage.db')
      const db = openDb(path) // left open: its last writes are in usage.db-wal
      db.insert(requests).values([row('a'), row('b')]).run()
      expect(existsSync(`${path}-wal`)).toBe(true)

      const backup = backupDatabase(path, join(dir, 'backups'))
      expect(statSync(backup).mode & 0o777).toBe(0o600)
      const copy = new Database(backup, { readonly: true })
      expect((copy.query('SELECT count(*) AS n FROM requests').get() as { n: number }).n).toBe(2)
      expect((copy.query('SELECT sum(records) AS n FROM usage_rollup').get() as { n: number }).n).toBe(2)
      copy.close()
      expect(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.partial'))).toEqual([])
    }))

  test('a missing database is an error, not an empty backup', () =>
    withDir((dir) => {
      expect(() => backupDatabase(join(dir, 'nope.db'), join(dir, 'backups'))).toThrow('no database')
    }))

  test('backups made in the same second get distinct names', () =>
    withDir((dir) => {
      const path = join(dir, 'usage.db')
      openDb(path)
      const at = new Date(Date.UTC(2026, 10, 24, 15, 30, 0, 1))
      const a = backupDatabase(path, join(dir, 'b'), at)
      const b = backupDatabase(path, join(dir, 'b'), new Date(at.getTime() + 1))
      expect(a).not.toBe(b)
      expect(a).toMatch(/usage-20261124T153000001Z-[0-9a-f]{8}\.db$/)
      // Even the very same millisecond doesn't overwrite.
      const c = backupDatabase(path, join(dir, 'b'), at)
      expect(c).not.toBe(a)
      expect(readdirSync(join(dir, 'b'))).toHaveLength(3)
    }))
})

describe('pruneBackups', () => {
  test('keeps the newest N backups and ignores other files', () =>
    withDir((dir) => {
      const path = join(dir, 'usage.db')
      openDb(path)
      const out = join(dir, 'b')
      for (let i = 0; i < 4; i++) backupDatabase(path, out, new Date(Date.UTC(2026, 0, 1 + i)))
      Bun.write(join(out, 'notes.txt'), 'keep me')
      const removed = pruneBackups(out, 2)
      expect(removed.map((f) => f.slice(0, 24))).toEqual(['usage-20260101T000000000', 'usage-20260102T000000000'])
      expect(readdirSync(out).sort().map((f) => f.slice(0, 24))).toEqual(['notes.txt', 'usage-20260103T000000000', 'usage-20260104T000000000'])
    }))
})

describe('backup file permissions', () => {
  test('the partial file is owner-only even in a world-readable directory with umask 022', () =>
    withDir((dir) => {
      const path = join(dir, 'usage.db')
      openDb(path)
      const out = join(dir, 'shared')
      require('node:fs').mkdirSync(out, { mode: 0o755 })
      const old = process.umask(0o022)
      try {
        const backup = backupDatabase(path, out)
        expect(statSync(backup).mode & 0o777).toBe(0o600)
      } finally {
        process.umask(old)
      }
    }))
})
