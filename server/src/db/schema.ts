// Usage database schema.
//
// Conventions (carried over from burn):
// - Money is integer micro-dollars (1 USD = 1_000_000), never floats.
// - Unknown values are NULL, never invented as 0.
// - Each request is stored once; re-delivery is ignored via its primary key.

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// One row per model request, from any source.
export const requests = sqliteTable(
  'requests',
  {
    // Stable per source, e.g. "cliproxy:<request_id>:<timestamp>".
    id: text('id').primaryKey(),
    // Where the record came from: 'cliproxy' today; 'openrouter', 'lmstudio' later.
    source: text('source').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),

    // What was used.
    provider: text('provider').notNull(), // 'claude', 'codex', ...
    model: text('model').notNull(), // model that actually served the request
    requestedModel: text('requested_model'), // what the client asked for

    // Which upstream account served it (CLIProxyAPI auth file).
    accountRef: text('account_ref'),
    accountLabel: text('account_label'),

    // Who sent it. Machines are resolved from these via machine_identities.
    clientKeyHash: text('client_key_hash'), // sha256 prefix of the proxy key used
    clientIp: text('client_ip'), // original client IP (tailnet IP when forwarded)
    userAgent: text('user_agent'),
    tool: text('tool'), // 'claude-code', 'codex', or the user agent's product name
    sessionId: text('session_id'),
    endpoint: text('endpoint'),

    // Outcome and timing.
    failed: integer('failed', { mode: 'boolean' }).notNull(),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    timeToFirstTokenMs: integer('ttft_ms'),

    // Tokens, split the way providers price them (no overlaps).
    inputTokens: integer('input_tokens'), // uncached input
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    outputTokens: integer('output_tokens'), // includes reasoning
    reasoningTokens: integer('reasoning_tokens'),

    // API-equivalent cost; NULL when the model has no price.
    costMicros: integer('cost_micros'),
    // What cache reads saved versus paying the full input rate.
    cacheSavingsMicros: integer('cache_savings_micros'),
    pricedAs: text('priced_as'), // price-table entry used, for auditing
  },
  (t) => [
    index('requests_occurred_at').on(t.occurredAt),
    // When live collection began (the import cutoff), and per-source scans.
    index('requests_source').on(t.source, t.occurredAt),
    index('requests_client_key').on(t.clientKeyHash),
    index('requests_client_ip').on(t.clientIp),
    // Recomputing a session's last request when rows are deleted (db/rollup.ts).
    index('requests_session').on(t.sessionId),
    // Rows still waiting for a price, by model, so repricing skips the rest.
    index('requests_unpriced')
      .on(t.model)
      .where(sql`cost_micros IS NULL OR cache_savings_micros IS NULL`),
  ],
)

// Per-15-minute totals of `requests`, what the usage summary reads instead
// of scanning every request. 15 minutes divides every time zone's offset, so
// slots never straddle a local day.
//
// Kept exact by triggers on `requests` (insert, update, delete) that live in
// db/rollup.ts, not here: drizzle schemas can't declare triggers. Nullable
// grouping columns are stored as '' so they can be part of the key.
export const usageRollup = sqliteTable(
  'usage_rollup',
  {
    slot: integer('slot').notNull(), // start of the 15-minute slot, ms
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    accountLabel: text('account_label').notNull(),
    clientKeyHash: text('client_key_hash').notNull(),
    clientIp: text('client_ip').notNull(),
    records: integer('records').notNull(),
    unpricedRecords: integer('unpriced_records').notNull(),
    costMicros: integer('cost_micros').notNull(),
    cacheSavingsMicros: integer('cache_savings_micros').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
  },
  (t) => [primaryKey({ columns: [t.slot, t.provider, t.model, t.accountLabel, t.clientKeyHash, t.clientIp] })],
)

// Each session's latest request per model, for counting sessions active in
// a window without scanning requests: windows always run up to now, so a
// session was active in one exactly when its last request falls inside.
// Maintained by the same triggers as usage_rollup.
export const usageSessions = sqliteTable(
  'usage_sessions',
  {
    tool: text('tool').notNull(), // coalesce(tool, 'other')
    sessionId: text('session_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    lastAt: integer('last_at').notNull(), // ms
  },
  (t) => [primaryKey({ columns: [t.tool, t.sessionId, t.provider, t.model] }), index('usage_sessions_last_at').on(t.lastAt)],
)

// Named machines ("laptop", "desktop").
export const machines = sqliteTable('machines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

// How a request is recognized as coming from a machine: the proxy key it
// used, or its client IP. A key match wins over an IP match.
export const machineIdentities = sqliteTable(
  'machine_identities',
  {
    kind: text('kind', { enum: ['key', 'ip'] }).notNull(),
    value: text('value').notNull(),
    machineId: integer('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.value] })],
)

// Devices on the tailnet, synced from `tailscale status`, keyed by IP.
// This machine is also listed under its loopback addresses, so requests
// made locally get its name too.
export const tailnetDevices = sqliteTable('tailnet_devices', {
  ip: text('ip').primaryKey(),
  name: text('name').notNull(), // first label of the MagicDNS name
  dnsName: text('dns_name'),
  os: text('os'),
  isSelf: integer('is_self', { mode: 'boolean' }).notNull(),
  online: integer('online', { mode: 'boolean' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
})

