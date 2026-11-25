// Fails if the database built from server/drizzle/ differs from the one the
// TypeScript schema describes (T6). drizzle-kit check/generate only compare
// snapshot metadata, so a hand-edited migration or a schema change they can't
// resolve non-interactively would otherwise pass.
//
// Run with: bun scripts/check-migrations.ts
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

const root = new URL('..', import.meta.url).pathname

const exported = Bun.spawnSync(['npx', 'drizzle-kit', 'export', '--sql'], { cwd: root, stderr: 'inherit' })
if (exported.exitCode !== 0) {
  console.error('drizzle-kit export failed')
  process.exit(1)
}
const fromSchema = new Database(':memory:')
fromSchema.exec(exported.stdout.toString())

const fromMigrations = new Database(':memory:')
migrate(drizzle(fromMigrations), { migrationsFolder: `${root}server/drizzle` })

type Row = Record<string, unknown>

// A comparable description of every user table, view and trigger.
function describe(db: Database) {
  const all = (sql: string) => db.query(sql).all() as Row[]
  const objects = all(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_migrations%'
     ORDER BY type, name`,
  )
  const out: Record<string, unknown> = {}
  for (const o of objects) {
    const name = String(o.name)
    const sql = String(o.sql ?? '')
    if (o.type === 'index') continue // covered per table below
    if (o.type !== 'table') {
      out[`${o.type}:${name}`] = sql.replace(/\s+/g, ' ').trim()
      continue
    }
    const q = (pragma: string) => all(`PRAGMA ${pragma}('${name.replaceAll("'", "''")}')`)
    const columns = q('table_xinfo')
      .map((c) => ({ name: c.name, type: String(c.type).toUpperCase(), notnull: c.notnull, default: c.dflt_value, pk: c.pk, hidden: c.hidden }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const indexes = q('index_list')
      .map((i) => {
        const cols = all(`PRAGMA index_xinfo('${String(i.name).replaceAll("'", "''")}')`)
          .filter((c) => c.key)
          .map((c) => `${c.name ?? '<expr>'}${c.desc ? ' desc' : ''}${c.coll && c.coll !== 'BINARY' ? ` collate ${c.coll}` : ''}`)
        // Auto-index names depend on declaration order, so key those by shape.
        const auto = String(i.name).startsWith('sqlite_autoindex_')
        return `${auto ? '(auto)' : i.name} unique=${i.unique} origin=${i.origin} partial=${i.partial} (${cols.join(', ')})`
      })
      .sort()
    const foreignKeys = q('foreign_key_list')
      .map((f) => `${f.from} -> ${f.table}.${f.to} on_update=${f.on_update} on_delete=${f.on_delete} match=${f.match}`)
      .sort()
    out[`table:${name}`] = {
      columns,
      indexes,
      foreignKeys,
      autoincrement: /\bAUTOINCREMENT\b/i.test(sql),
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
      strict: /\)\s*STRICT\b/i.test(sql),
    }
  }
  return out
}

const want = describe(fromSchema)
const got = describe(fromMigrations)
const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()
const diffs = keys.filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]))

if (diffs.length === 0) {
  console.log(`Migrations match the schema (${keys.length} objects).`)
  process.exit(0)
}
console.error('The database built from server/drizzle/ does not match server/src/db/schema.ts:')
const items = (v: unknown): string[] => {
  if (v == null) return []
  if (typeof v !== 'object') return [JSON.stringify(v)]
  return Object.entries(v as Row).flatMap(([field, value]) =>
    Array.isArray(value) ? value.map((x) => `${field}: ${typeof x === 'string' ? x : JSON.stringify(x)}`) : [`${field}: ${JSON.stringify(value)}`],
  )
}
for (const k of diffs) {
  const a = items(want[k])
  const b = items(got[k])
  console.error(`\n${k}${want[k] == null ? ' (only in migrations)' : got[k] == null ? ' (missing from migrations)' : ''}`)
  for (const x of a.filter((x) => !b.includes(x))) console.error(`  - schema only:     ${x}`)
  for (const x of b.filter((x) => !a.includes(x))) console.error(`  + migrations only: ${x}`)
}
console.error("\nRun 'npm run db:generate' and commit server/drizzle/, or fix the migration by hand.")
process.exit(1)
