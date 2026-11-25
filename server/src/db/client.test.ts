import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './client'

const mode = (path: string) => statSync(path).mode & 0o777

describe('database file permissions (S8)', () => {
  test('a new database and its WAL files are owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-'))
    try {
      const path = join(dir, 'nested', 'usage.db')
      openDb(path)
      expect(mode(path)).toBe(0o600)
      expect(mode(`${path}-wal`)).toBe(0o600)
      expect(mode(join(dir, 'nested'))).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an existing world-readable database is tightened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-'))
    try {
      const path = join(dir, 'usage.db')
      writeFileSync(path, '')
      chmodSync(path, 0o644)
      openDb(path)
      expect(mode(path)).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
