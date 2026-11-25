// Keeps `usage_rollup` and `usage_sessions` (see schema.ts) equal to
// GROUP BYs over `requests`.
//
// Triggers apply every insert, update and delete of a request to its slot,
// so all writers (collector, importers, repricing, manual SQL) stay in sync
// without knowing the rollup exists. They're created here rather than in a
// migration because drizzle schemas can't declare triggers; CREATE ... IF NOT
// EXISTS makes this safe on every start.

import type { Database } from 'bun:sqlite'

export const SLOT_MS = 15 * 60e3

// The rollup key and sums for a request row (`r` is NEW or OLD).
const key = (r: string) => ({
  slot: `(${r}.occurred_at / ${SLOT_MS}) * ${SLOT_MS}`,
  provider: `${r}.provider`,
  model: `${r}.model`,
  account_label: `coalesce(${r}.account_label, '')`,
  client_key_hash: `coalesce(${r}.client_key_hash, '')`,
  client_ip: `coalesce(${r}.client_ip, '')`,
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

const TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS usage_sessions_insert AFTER INSERT ON requests WHEN NEW.session_id IS NOT NULL BEGIN ${touchSession('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS usage_sessions_delete AFTER DELETE ON requests WHEN OLD.session_id IS NOT NULL BEGIN ${forgetSession('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS usage_sessions_update AFTER UPDATE OF ${SESSION_WATCHED.join(', ')} ON requests BEGIN ${forgetSession('OLD')} ${touchSession('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_insert AFTER INSERT ON requests BEGIN ${add('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_delete AFTER DELETE ON requests BEGIN ${subtract('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS usage_rollup_update AFTER UPDATE OF ${WATCHED.join(', ')} ON requests BEGIN ${subtract('OLD')} ${add('NEW')} END`,
]

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

// Installs the triggers, and rebuilds the rollup if it doesn't account for
// every request: the first start after the migration, or rows written while
// the triggers were missing (e.g. by an older build).
export function ensureRollup(sqlite: Database) {
  for (const trigger of TRIGGERS) sqlite.exec(trigger)
  const { requests } = sqlite.query('SELECT count(*) AS requests FROM requests').get() as { requests: number }
  const { rolled } = sqlite.query('SELECT coalesce(sum(records), 0) AS rolled FROM usage_rollup').get() as { rolled: number }
  // Sessions can't be checked as cheaply; an empty table next to requests
  // with sessions means it was never built.
  const sessionsMissing =
    !sqlite.query('SELECT 1 FROM usage_sessions LIMIT 1').get() && !!sqlite.query('SELECT 1 FROM requests WHERE session_id IS NOT NULL LIMIT 1').get()
  if (requests !== rolled || sessionsMissing) {
    const started = performance.now()
    rebuildRollup(sqlite)
    console.log(`[db] rebuilt usage rollup from ${requests} requests in ${Math.round(performance.now() - started)}ms`)
  }
}
