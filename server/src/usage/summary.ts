// Usage summary for the dashboard. Definitions follow T3 Code's usage view:
//
// - Processed tokens = uncached input + cached input + cache writes + output.
//   Reasoning is part of output, never added on top.
// - Cache savings = cache reads priced at (input rate − cache read rate).
// - Unpriced = share of requests with no known price (not of tokens or dollars).
// - Sessions = distinct client × session ids with activity in the window.
//   A session using two providers appears in both rows, but once in the total.
// - Days are the viewer's local days; "7d" means today and the 6 days before;
//   "all" starts on the day of the earliest stored request.
// - 24h and 7d are bucketed by hour, longer ranges by day. Hours are the
//   viewer's local hours (in +05:30 they start at :30 UTC).
// - Totals come from usage_rollup (15-minute slots), so a summary costs the
//   number of slots in the window, not the number of requests.

import { and, eq, gte, min, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { decodeKey, SLOT_MS } from '../db/rollup'
import { machineIdentities, machines, requests, tailnetDevices, usageRollup, usageSessions } from '../db/schema'
import { EARLIEST_PLAUSIBLE_MS } from './timestamps'

export type Range = '24h' | '7d' | '30d' | '90d' | 'all'
export const RANGES: Range[] = ['24h', '7d', '30d', '90d', 'all']
const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 }
const HOUR = 3600e3

export type Totals = {
  costMicros: number
  cacheSavingsMicros: number
  records: number
  unpricedRecords: number
  uncachedTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  processedTokens: number
}

const emptyTotals = (): Totals => ({
  costMicros: 0,
  cacheSavingsMicros: 0,
  records: 0,
  unpricedRecords: 0,
  uncachedTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  processedTokens: 0,
})

const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof Totals)[]

// Adds g's totals into acc (only the numeric totals; acc may carry labels too).
function addTo(acc: Totals, g: Totals) {
  for (const key of TOTAL_KEYS) acc[key] += g[key]
}

// --- Time window -----------------------------------------------------------------

// Local calendar day of an instant, as "YYYY-MM-DD".
function dayKeyFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ms: number) => fmt.format(ms)
}

// The previous calendar day of a "YYYY-MM-DD" key (pure date math, no time zones).
function previousDay(key: string) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

type Window = {
  startMs: number // first instant included
  bucket: 'hour' | 'day'
  keys: (number | string)[] // every bucket in order, including empty ones
  keyOf: (ms: number) => number | string
}

// Whether summaries can use `timeZone` now: the rollup's 15-minute slots
// only line up with local days if the offset is a whole number of slots.
// True for every zone in use today; not for e.g. "+00:01".
export function slotAlignedTimeZone(timeZone: string, now = Date.now()) {
  return offsetMs(timeZone, now) % SLOT_MS === 0
}

// The time zone's offset from UTC at an instant, in ms.
const offsetFormats = new Map<string, Intl.DateTimeFormat>()
function offsetMs(timeZone: string, ms: number) {
  let format = offsetFormats.get(timeZone)
  if (!format) offsetFormats.set(timeZone, (format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })))
  const parts = format.formatToParts(ms)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000
}

// Buckets of local hours: in a +05:30 zone they start at :30 past each UTC
// hour. Each instant is aligned with its own offset, so a DST change that
// moves the phase (Lord Howe shifts by 30 minutes) just makes one bucket
// shorter or longer instead of shifting the whole window.
function hourWindow(startMs: number, now: number, timeZone: string): Window {
  const memo = new Map<number, number>()
  const hourOf = (ms: number) => {
    const slot = Math.floor(ms / SLOT_MS) * SLOT_MS // offsets are whole slots
    let hour = memo.get(slot)
    if (hour === undefined) {
      const offset = offsetMs(timeZone, slot)
      hour = slot - ((((slot + offset) % HOUR) + HOUR) % HOUR)
      // Just after a DST change, the local hour began before the change (at
      // a time that reads differently); the bucket starts at the change.
      while (offsetMs(timeZone, hour) !== offset) hour += SLOT_MS
      memo.set(slot, hour)
    }
    return hour
  }
  const first = hourOf(startMs)
  const keys: number[] = []
  for (let slot = first; slot <= now; slot += SLOT_MS) {
    const key = hourOf(slot)
    if (key !== keys[keys.length - 1]) keys.push(key)
  }
  return { startMs: first, bucket: 'hour', keys, keyOf: hourOf }
}

function windowFor(range: Range, timeZone: string, now: number, earliestMs: number | null): Window {
  if (range === '24h') return hourWindow(now - 23 * HOUR, now, timeZone)

  const dayOf = dayKeyFormatter(timeZone)
  // Built newest first and reversed once (unshift per day is quadratic).
  const keys = [dayOf(now)]
  if (range === 'all') {
    // A stray ancient row must not stretch the window across centuries.
    const firstDay = dayOf(Math.min(Math.max(earliestMs ?? now, EARLIEST_PLAUSIBLE_MS), now))
    while (keys[keys.length - 1] > firstDay) keys.push(previousDay(keys[keys.length - 1]))
  } else {
    while (keys.length < RANGE_DAYS[range]) keys.push(previousDay(keys[keys.length - 1]))
  }
  keys.reverse()

  // The first slot of the window's first local day: its local midnight, since
  // every zone's offset is a whole number of slots.
  let startMs = Math.floor((now - (keys.length + 1) * 86400e3) / SLOT_MS) * SLOT_MS
  while (dayOf(startMs) < keys[0]) startMs += SLOT_MS
  if (range === '7d') return hourWindow(startMs, now, timeZone)
  return { startMs, bucket: 'day', keys, keyOf: dayOf }
}

// --- Machine names ---------------------------------------------------------------
// Preference: dedicated key name > custom IP name > Tailscale name > IP.

const byKey = alias(machineIdentities, 'by_key')
const byIp = alias(machineIdentities, 'by_ip')
const keyMachine = alias(machines, 'key_machine')
const ipMachine = alias(machines, 'ip_machine')

const rollupKey = sql.raw(decodeKey('"usage_rollup"."client_key_hash"'))
const rollupIp = sql.raw(decodeKey('"usage_rollup"."client_ip"'))
const machine = {
  name: sql<string>`coalesce(${keyMachine.name}, ${ipMachine.name}, ${tailnetDevices.name}, ${rollupIp}, 'unknown')`,
  nameSource: sql<'custom' | 'tailscale' | null>`case
    when ${keyMachine.name} is not null or ${ipMachine.name} is not null then 'custom'
    when ${tailnetDevices.name} is not null then 'tailscale' end`,
  // The identity a rename applies to: the dedicated key if there is one, else the IP.
  identityKind: sql<'key' | 'ip'>`case when ${keyMachine.name} is not null then 'key' else 'ip' end`,
  identityValue: sql<string | null>`case when ${keyMachine.name} is not null then ${rollupKey} else ${rollupIp} end`,
}

// The vendor serving a model, from the model name when it says (so requests
// routed through another harness or an OpenAI-compatible endpoint still
// count for their vendor), else from the upstream provider.
function providerOf(model: typeof usageRollup.model | typeof usageSessions.model, upstreamProvider: typeof usageRollup.provider | typeof usageSessions.provider) {
  const modelPath = sql`'/' || lower(trim(${model}))`
  const upstream = sql`lower(trim(${upstreamProvider}))`
  return sql<string>`case
    when ${modelPath} glob '*/claude-*' then 'anthropic'
    when ${modelPath} glob '*/gpt-*'
      or ${modelPath} glob '*/chatgpt-*'
      or ${modelPath} glob '*/o[1-9]' or ${modelPath} glob '*/o[1-9]-*' then 'openai'
    when ${modelPath} glob '*/gemini-*' then 'gemini'
    when ${modelPath} glob '*/grok-*' then 'xai'
    when ${upstream} in ('claude', 'anthropic') then 'anthropic'
    when ${upstream} in ('codex', 'openai') then 'openai'
    when ${upstream} in ('google', 'gemini') then 'gemini'
    when ${upstream} in ('', 't3', 't3-code', 'claude-code', 'other', 'unknown') then 'unknown'
    else ${upstream} end`
}

// --- Summary ---------------------------------------------------------------------

// Summaries are reused until the data or the window changes: dashboards
// poll, and with no new requests every poll would recompute the same answer.
// total_changes() counts this connection's writes (collector, API, triggers);
// data_version moves when another process (the CLI importers) commits.
const CACHE_SIZE = 32
const caches = new WeakMap<Db, Map<string, UsageSummary>>()

export function usageSummary(db: Db, range: Range, timeZone: string, now = Date.now()): UsageSummary {
  // Inside a caller's transaction the result may include uncommitted writes
  // that a rollback would undo (total_changes() doesn't rewind), so it
  // mustn't be cached or served from cache.
  if (db.$client.inTransaction) return computeSummary(db, range, timeZone, summaryWindow(db, range, timeZone, now))
  // One read transaction: the version check, totals and sessions all see the
  // same snapshot, even if another process commits meanwhile.
  return db.$client.transaction(() => cachedSummary(db, range, timeZone, now))()
}

function summaryWindow(db: Db, range: Range, timeZone: string, now: number) {
  const earliest = db.select({ at: min(requests.occurredAt) }).from(requests).get()?.at
  return windowFor(range, timeZone, now, earliest ? earliest.getTime() : null)
}

function cachedSummary(db: Db, range: Range, timeZone: string, now: number): UsageSummary {
  const window = summaryWindow(db, range, timeZone, now)
  const { changes } = db.$client.query('SELECT total_changes() AS changes').get() as { changes: number }
  const { data_version: version } = db.$client.query('PRAGMA data_version').get() as { data_version: number }
  const cacheKey = JSON.stringify([range, timeZone, window.startMs, window.keys.length, window.keys.at(-1), changes, version])
  let cache = caches.get(db)
  if (!cache) caches.set(db, (cache = new Map()))
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const summary = computeSummary(db, range, timeZone, window)
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
  cache.set(cacheKey, summary)
  return summary
}

function computeSummary(db: Db, range: Range, timeZone: string, window: Window) {

  // One row per slot × provider × model × account × machine; everything else
  // is built from these.
  const provider = providerOf(usageRollup.model, usageRollup.provider)
  const account = sql<string>`coalesce(${sql.raw(decodeKey('"usage_rollup"."account_label"'))}, 'unknown')`
  const groups = db
    .select({
      slot: usageRollup.slot,
      provider,
      model: usageRollup.model,
      account,
      ...machine,
      costMicros: sql<number>`sum(${usageRollup.costMicros})`,
      cacheSavingsMicros: sql<number>`sum(${usageRollup.cacheSavingsMicros})`,
      records: sql<number>`sum(${usageRollup.records})`,
      unpricedRecords: sql<number>`sum(${usageRollup.unpricedRecords})`,
      uncachedTokens: sql<number>`sum(${usageRollup.inputTokens})`,
      cachedTokens: sql<number>`sum(${usageRollup.cacheReadTokens})`,
      cacheWriteTokens: sql<number>`sum(${usageRollup.cacheWriteTokens})`,
      outputTokens: sql<number>`sum(${usageRollup.outputTokens})`,
    })
    .from(usageRollup)
    .leftJoin(byKey, and(eq(byKey.kind, 'key'), sql`${byKey.value} = ${rollupKey}`))
    .leftJoin(keyMachine, eq(keyMachine.id, byKey.machineId))
    .leftJoin(byIp, and(eq(byIp.kind, 'ip'), sql`${byIp.value} = ${rollupIp}`))
    .leftJoin(ipMachine, eq(ipMachine.id, byIp.machineId))
    .leftJoin(tailnetDevices, sql`${tailnetDevices.ip} = ${rollupIp}`)
    .where(gte(usageRollup.slot, window.startMs))
    .groupBy(usageRollup.slot, provider, usageRollup.model, account, machine.name, machine.identityKind, machine.identityValue)
    .all()
    .map((g) => ({ ...g, processedTokens: g.uncachedTokens + g.cachedTokens + g.cacheWriteTokens + g.outputTokens }))

  // Sessions active in the window: their last request is in it (windows run
  // up to now). Distinct per (tool, session id), as one session can use
  // several models.
  const sessionProvider = providerOf(usageSessions.model, usageSessions.provider)
  const sessionIdentity = sql`json_array(${usageSessions.tool}, ${usageSessions.sessionId})`
  const activeSessions = gte(usageSessions.lastAt, window.startMs)
  const sessions = db
    .select({ provider: sessionProvider, sessions: sql<number>`count(distinct ${sessionIdentity})` })
    .from(usageSessions)
    .where(activeSessions)
    .groupBy(sessionProvider)
    .all()
  const sessionsOf = new Map(sessions.map((s) => [s.provider, s.sessions]))
  const totalSessions = db
    .select({ count: sql<number>`count(distinct ${sessionIdentity})` })
    .from(usageSessions)
    .where(activeSessions)
    .get()?.count ?? 0

  const totals = emptyTotals()
  const providers = new Map<string, Totals>()
  const models = new Map<string, Totals & { provider: string; model: string }>()
  const accounts = new Map<string, Totals & { name: string }>()
  type ModelTotals = Totals & { provider: string; model: string }
  const machinesByName = new Map<
    string,
    Totals & {
      name: string
      nameSource: 'custom' | 'tailscale' | null
      identities: { kind: 'key' | 'ip'; value: string }[]
      models: Map<string, ModelTotals> // this machine's usage per model
    }
  >()
  // Per bucket: totals by provider and by machine name.
  type Point = { costMicros: number; tokens: number }
  const series = new Map<number | string, { providers: Map<string, Point>; machines: Map<string, Point> }>(
    window.keys.map((k) => [k, { providers: new Map(), machines: new Map() }]),
  )

  for (const g of groups) {
    addTo(totals, g)
    addTo(getOr(providers, g.provider, emptyTotals), g)
    addTo(getOr(models, `${g.provider}\u0000${g.model}`, () => ({ ...emptyTotals(), provider: g.provider, model: g.model })), g)
    addTo(getOr(accounts, g.account, () => ({ ...emptyTotals(), name: g.account })), g)

    const m = getOr(machinesByName, g.name, () => ({
      ...emptyTotals(),
      name: g.name,
      nameSource: g.nameSource,
      identities: [],
      models: new Map(),
    }))
    addTo(m, g)
    addTo(getOr(m.models, `${g.provider}\u0000${g.model}`, () => ({ ...emptyTotals(), provider: g.provider, model: g.model })), g)
    if (g.identityValue && !m.identities.some((i) => i.kind === g.identityKind && i.value === g.identityValue)) {
      m.identities.push({ kind: g.identityKind, value: g.identityValue })
    }

    const bucket = series.get(window.keyOf(g.slot))
    if (bucket) {
      for (const point of [getOr(bucket.providers, g.provider, emptyPoint), getOr(bucket.machines, g.name, emptyPoint)]) {
        point.costMicros += g.costMicros
        point.tokens += g.processedTokens
      }
    }
  }

  const byCost = <T extends Totals>(a: T, b: T) => b.costMicros - a.costMicros || b.processedTokens - a.processedTokens

  return {
    range,
    timeZone,
    bucket: window.bucket,
    totals: { ...totals, sessions: totalSessions },
    providers: [...providers].map(([name, t]) => ({ provider: name, sessions: sessionsOf.get(name) ?? 0, ...t })).sort(byCost),
    series: [...series].map(([key, b]) => ({ key, providers: Object.fromEntries(b.providers), machines: Object.fromEntries(b.machines) })),
    byModel: [...models.values()].sort(byCost),
    byMachine: [...machinesByName.values()]
      .map((m) => ({ ...m, models: [...m.models.values()].sort(byCost) }))
      .sort(byCost),
    byAccount: [...accounts.values()].sort(byCost),
  }
}

export type UsageSummary = ReturnType<typeof computeSummary>

const emptyPoint = () => ({ costMicros: 0, tokens: 0 })

function getOr<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) map.set(key, (value = create()))
  return value
}
