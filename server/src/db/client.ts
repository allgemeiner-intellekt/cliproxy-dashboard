import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureRollup } from './rollup'
import * as schema from './schema'

export type Db = ReturnType<typeof openDb>

// Opens (creating if needed) the SQLite database and applies pending migrations.
export function openDb(configuredPath: string) {
  const onDisk = configuredPath !== ':memory:'
  let path = configuredPath
  if (onDisk) {
    mkdirSync(dirname(configuredPath), { recursive: true, mode: 0o700 })
    // Create the file owner-only before SQLite does, so it never exists with
    // the default (often world-readable) mode. SQLite gives -wal/-shm the
    // database file's mode.
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
    // SQLite names -wal/-shm after the real file, so resolve symlinks and use
    // that path for both opening and permissions.
    path = realpathSync(path)
  }
  const sqlite = new Database(path, { create: true })
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA synchronous = NORMAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  // INSERT OR REPLACE must fire delete triggers, or usage_rollup keeps the
  // replaced row (see db/rollup.ts).
  sqlite.exec('PRAGMA recursive_triggers = ON;')
  if (onDisk) restrictToOwner(path)

  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
  ensureRollup(sqlite)
  return db
}

// Usage history names machines and accounts; keep it readable by its owner
// only, tightening databases created before this was enforced.
function restrictToOwner(path: string) {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue
    try {
      chmodSync(file, 0o600)
    } catch (err) {
      console.warn(`[db] could not restrict permissions on ${file}: ${(err as Error).message}`)
    }
  }
}
