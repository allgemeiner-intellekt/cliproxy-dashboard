// Keeps `usage_rollup` and `usage_sessions` (see schema.ts) equal to
// GROUP BYs over `requests`.
//
// Triggers apply every insert, update and delete of a request to its slot,
// so all writers (collector, importers, repricing, manual SQL) stay in sync
// without knowing the rollup exists. They're created here rather than in a
// migration because drizzle schemas can't declare triggers, and checked on
// every open: a missing or changed trigger is replaced and the tables are
// rebuilt, since writes made without it weren't applied.
//
// Contract for writers: INSERT OR REPLACE deletes the old row without firing
// delete triggers unless `PRAGMA recursive_triggers = ON`, which openDb()
// sets. Other connections (e.g. the sqlite3 CLI) must set it too or avoid
// REPLACE; plain INSERT, UPDATE, DELETE and upserts are always safe.

import type { Database } from 'bun:sqlite'

export const SLOT_MS = 15 * 60e3

// Stands for NULL in the rollup's key columns, which must be NOT NULL to be
// part of the primary key. A NUL character, so a real '' keeps its meaning.
export const NULL_KEY = 'char(0)'

// The rollup key and sums for a request row (`r` is NEW or OLD).
const key = (r: string) => ({
  slot: `(${r}.occurred_at / ${SLOT_MS}) * ${SLOT_MS}`,
  provider: `${r}.provider`,
  model: `${r}.model`,
  account_label: `coalesce(${r}.account_label, ${NULL_KEY})`,
  client_key_hash: `coalesce(${r}.client_key_hash, ${NULL_KEY})`,
  client_ip: `coalesce(${r}.client_ip, ${NULL_KEY})`,
})
const sums = (r: string) => ({
  records: '1',
  unpriced_records: `(${r}.cost_micros IS NULL)`,
  cost_micros: `coalesce(${r}.cost_micros, 0)`,
  cache_savings_micros: `coalesce(${r}.cache_savings_micros, 0)`,
  input_tokens: `coalesce(${r}.input_tokens, 0)`,
  cache_read_tokens: `coalesce(${r}.cache_read_tokens, 0)`,
  cache_write_tokens: `coalesce(${r}.cache_write_tokens, 0)`,
  output_tokens: `coalesce(${r}.output_tokens, 0)`,
})
const KEY_COLUMNS = Object.keys(key('x'))
const SUM_COLUMNS = Object.keys(sums('x'))
// Columns whose change moves a request's contribution.
const WATCHED = ['occurred_at', 'provider', 'model', 'account_label', 'client_key_hash', 'client_ip', 'cost_micros', 'cache_savings_micros', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens']

function add(r: string) {
  const k = key(r)
  const v = sums(r)
  return `INSERT INTO usage_rollup (${[...KEY_COLUMNS, ...SUM_COLUMNS].join(', ')})
    VALUES (${[...Object.values(k), ...Object.values(v)].join(', ')})
    ON CONFLICT (${KEY_COLUMNS.join(', ')}) DO UPDATE SET ${SUM_COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(', ')};`
}

function subtract(r: string) {
  const k = key(r)
  const v = sums(r)
  const where = KEY_COLUMNS.map((c) => `${c} = ${k[c as keyof typeof k]}`).join(' AND ')
  return `UPDATE usage_rollup SET ${SUM_COLUMNS.map((c) => `${c} = ${c} - ${v[c as keyof typeof v]}`).join(', ')} WHERE ${where};
    DELETE FROM usage_rollup WHERE ${where} AND records <= 0;`
}

// usage_sessions: a request with a session raises its session's last_at; a
// removed or moved one recomputes it from what's left (indexed by session_id).
const SESSION_WATCHED = ['occurred_at', 'tool', 'session_id', 'provider', 'model']
const sessionKey = (r: string) =>
  `tool = coalesce(${r}.tool, 'other') AND session_id = ${r}.session_id AND provider = ${r}.provider AND model = ${r}.model`
function touchSession(r: string) {
  return `INSERT INTO usage_sessions (tool, session_id, provider, model, last_at)
    SELECT coalesce(${r}.tool, 'other'), ${r}.session_id, ${r}.provider, ${r}.model, ${r}.occurred_at WHERE ${r}.session_id IS NOT NULL
    ON CONFLICT (tool, session_id, provider, model) DO UPDATE SET last_at = max(last_at, excluded.last_at);`
}
function forgetSession(r: string) {
  const same = `FROM requests WHERE session_id = ${r}.session_id AND coalesce(tool, 'other') = coalesce(${r}.tool, 'other') AND provider = ${r}.provider AND model = ${r}.model`
  return `DELETE FROM usage_sessions WHERE ${sessionKey(r)} AND NOT EXISTS (SELECT 1 ${same});
    UPDATE usage_sessions SET last_at = (SELECT max(occurred_at) ${same}) WHERE ${sessionKey(r)};`
}

// [name, DDL]; the DDL is exactly what sqlite_master stores, for comparison.
const TRIGGERS: [string, string][] = [
  ['usage_sessions_insert', `AFTER INSERT ON requests WHEN NEW.session_id IS NOT NULL BEGIN ${touchSession('NEW')} END`],
  ['usage_sessions_delete', `AFTER DELETE ON requests WHEN OLD.session_id IS NOT NULL BEGIN ${forgetSession('OLD')} END`],
  ['usage_sessions_update', `AFTER UPDATE OF ${SESSION_WATCHED.join(', ')} ON requests BEGIN ${forgetSession('OLD')} ${touchSession('NEW')} END`],
  ['usage_rollup_insert', `AFTER INSERT ON requests BEGIN ${add('NEW')} END`],
  ['usage_rollup_delete', `AFTER DELETE ON requests BEGIN ${subtract('OLD')} END`],
  ['usage_rollup_update', `AFTER UPDATE OF ${WATCHED.join(', ')} ON requests BEGIN ${subtract('OLD')} ${add('NEW')} END`],
].map(([name, body]) => [name, `CREATE TRIGGER ${name} ${body}`])

// Recomputes both tables from `requests`.
export function rebuildRollup(sqlite: Database) {
  const k = key('requests')
  const v = sums('requests')
  sqlite.transaction(() => {
    sqlite.exec('DELETE FROM usage_sessions')
    sqlite.exec(`INSERT INTO usage_sessions (tool, session_id, provider, model, last_at)
      SELECT coalesce(tool, 'other'), session_id, provider, model, max(occurred_at)
      FROM requests WHERE session_id IS NOT NULL GROUP BY coalesce(tool, 'other'), session_id, provider, model`)
    sqlite.exec('DELETE FROM usage_rollup')
    sqlite.exec(`INSERT INTO usage_rollup (${[...KEY_COLUMNS, ...SUM_COLUMNS].join(', ')})
      SELECT ${Object.values(k).join(', ')}, ${SUM_COLUMNS.map((c) => (c === 'records' ? 'count(*)' : `sum(${v[c as keyof typeof v]})`)).join(', ')}
      FROM requests GROUP BY ${Object.values(k).join(', ')}`)
  })()
}

// Installs or repairs the triggers, and rebuilds both tables if a trigger
// was missing or different (writes since then weren't applied) or the
// rollup doesn't account for every request. One write transaction, so no
// write slips in between the check and the rebuild.
export function ensureRollup(sqlite: Database) {
  sqlite
    .transaction(() => {
      let repaired = false
      for (const [name, ddl] of TRIGGERS) {
        const existing = sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | null
        if (existing?.sql === ddl) continue
        sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`)
        sqlite.exec(ddl)
        repaired = true
      }
      const { requests } = sqlite.query('SELECT count(*) AS requests FROM requests').get() as { requests: number }
      const { rolled } = sqlite.query('SELECT coalesce(sum(records), 0) AS rolled FROM usage_rollup').get() as { rolled: number }
      if (!repaired && requests === rolled) return
      const started = performance.now()
      rebuildRollup(sqlite)
      if (requests) console.log(`[db] rebuilt usage rollup from ${requests} requests in ${Math.round(performance.now() - started)}ms`)
    })
    .immediate()
}
