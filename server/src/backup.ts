// Online backup of the usage database, safe while the server is running:
//   bun server/src/backup.ts [backup dir] [--keep N]
//
// Copying usage.db with cp can miss what's still in usage.db-wal, or catch a
// write halfway. VACUUM INTO writes a consistent snapshot from one read
// transaction instead, compacted, without blocking the collector's writes.
// The proxy deletes usage records once read, so this history exists nowhere
// else.

import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { storageEnv } from './env'

const PREFIX = 'usage-'
const SUFFIX = '.db'
// Exactly what backupDatabase() names its files; pruning touches nothing else.
const BACKUP_NAME = /^usage-\d{8}T\d{9}Z-[0-9a-f]{8}\.db$/

// Snapshot of `dbPath` as `<dir>/usage-<UTC timestamp>-<random>.db`; returns its path.
export function backupDatabase(dbPath: string, dir: string, now = new Date()): string {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The random suffix keeps two backups in the same millisecond (or running
  // at once) from sharing a staging or final file; names still sort by time.
  const stamp = now.toISOString().replace(/[-:.]/g, '') // 20261124T153000123Z
  const target = join(dir, `${PREFIX}${stamp}-${randomBytes(4).toString('hex')}${SUFFIX}`)
  const tmp = `${target}.partial`
  rmSync(tmp, { force: true })
  // Owner-only from the first byte: VACUUM INTO would create the file with
  // the umask's mode, readable by others in a shared directory. It accepts an
  // existing empty file.
  closeSync(openSync(tmp, 'wx', 0o600))
  chmodSync(tmp, 0o600) // in case the umask removed owner bits

  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.query('VACUUM INTO ?').run(tmp)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  } finally {
    db.close()
  }
  const check = new Database(tmp, { readonly: true })
  try {
    const result = (check.query('PRAGMA quick_check').get() as { quick_check: string }).quick_check
    if (result !== 'ok') throw new Error(`backup failed its integrity check: ${result}`)
  } finally {
    check.close()
  }
  renameSync(tmp, target)
  return target
}

// Deletes all but the newest `keep` backups in `dir`; returns what it removed.
export function pruneBackups(dir: string, keep: number): string[] {
  const backups = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && BACKUP_NAME.test(e.name))
    .map((e) => e.name)
    .sort() // timestamps sort chronologically
  const old = backups.slice(0, Math.max(0, backups.length - keep))
  for (const f of old) rmSync(join(dir, f))
  return old
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { keep: { type: 'string' } }, allowPositionals: true })
  const env = storageEnv()
  const dir = resolve(positionals[0] ?? join(env.databasePath, '..', 'backups'))
  const keep = values.keep === undefined ? undefined : Number(values.keep)
  if (keep !== undefined && !(Number.isInteger(keep) && keep >= 1)) {
    console.error('--keep must be a whole number of at least 1')
    process.exit(1)
  }
  try {
    const started = performance.now()
    const path = backupDatabase(env.databasePath, dir)
    console.log(`Backed up ${env.databasePath} to ${path} in ${Math.round(performance.now() - started)}ms`)
    if (keep !== undefined) for (const f of pruneBackups(dir, keep)) console.log(`Removed old backup ${f}`)
  } catch (err) {
    console.error(`Backup failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
