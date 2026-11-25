// API-equivalent pricing from LiteLLM's public price table, with manual
// overrides from the database taking precedence.
//
// Subscription accounts aren't billed per token; this answers "what would
// this usage have cost on the pay-as-you-go API".

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../db/client'
import { priceOverrides } from '../db/schema'

const PRICE_TABLE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const REFRESH_EVERY_MS = 24 * 3600e3
// After a failed download, try again sooner than the daily refresh.
const RETRY_AFTER_FAILURE_MS = 15 * 60e3
// A stalled download (DNS black hole, captive portal) gives up after this.
const FETCH_TIMEOUT_MS = 30e3

// Micro-dollars per million tokens.
export type Rates = {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

export type Tokens = {
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
}

type LiteLlmEntry = {
  litellm_provider?: string
  mode?: string
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

// USD per token → micro-dollars per million tokens.
const perMTok = (usdPerToken: number) => Math.round(usdPerToken * 1e12)

// Providers whose own list prices we prefer when a model appears under several.
const FIRST_PARTY = ['anthropic', 'openai', 'meta', 'xai']

// Placeholder or alias names that don't identify a billable model.
const NEVER_PRICED = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable'])

// Muse models the price table doesn't list, priced by their nearest listed
// sibling: Wonder Full is subscription-only (never sold per token), so it
// takes standard Wonder's rates; unlisted "-contributor" variants take the
// contributor rates of the listed Spark contributor rows.
const CONTRIBUTOR_RATES: Rates = { input: 100_000, output: 200_000, cacheRead: 2_000, cacheWrite: null }

// "Claude-Opus-5-5[1m]" → "claude-opus-5-5" (context-size suffixes aren't separate prices).
export function normalizeModel(model: string) {
  return model.trim().toLowerCase().replace(/\[.*$/, '')
}

export class PriceBook {
  private table: Record<string, LiteLlmEntry> = {}
  private overrides = new Map<string, Rates>()
  loadedAt: number | null = null

  constructor(
    private db: Db,
    private cachePath: string,
  ) {}

  // Called after each successful refresh, e.g. to reprice stored rows.
  onRefresh: () => void = () => {}

  private refreshing: Promise<boolean> | null = null
  private timer?: ReturnType<typeof setTimeout>
  private running: Promise<boolean> | null = null

  // Loads overrides and the cached table from disk. Synchronous, so pricing
  // works from the last good table before any download.
  load() {
    this.loadOverrides()
    this.loadCache()
  }

  // Loads what's on disk, then refreshes in the background: daily, or sooner
  // after a failure. Returns at once; the promise settles with the first
  // refresh's outcome, for work that should wait for fresh prices if it can.
  start(): Promise<boolean> {
    if (this.running) return this.running
    this.load()
    const tick = async () => {
      const ok = await this.refresh()
      if (this.running === first) this.timer = setTimeout(tick, ok ? REFRESH_EVERY_MS : RETRY_AFTER_FAILURE_MS)
      return ok
    }
    const first = tick()
    this.running = first
    return first
  }

  stop() {
    this.running = null
    clearTimeout(this.timer)
  }

  // Downloads the latest table; on failure keeps whatever is loaded. Resolves
  // to whether it succeeded. Concurrent calls share one download.
  refresh(timeoutMs = FETCH_TIMEOUT_MS): Promise<boolean> {
    this.refreshing ??= this.download(timeoutMs).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async download(timeoutMs: number) {
    let table: Record<string, LiteLlmEntry>
    let text: string
    try {
      const res = await fetch(PRICE_TABLE_URL, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
      table = parsePriceTable(text)
    } catch (err) {
      console.warn(`[pricing] refresh failed, keeping ${this.loadedAt ? 'cached' : 'empty'} table: ${(err as Error).message}`)
      return false
    }
    this.table = table
    this.loadedAt = Date.now()
    try {
      // Write beside the cache and rename over it, so a failed or partial
      // write never replaces the last good copy.
      mkdirSync(dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, text)
        renameSync(tmp, this.cachePath)
      } catch (err) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // best effort
        }
        throw err
      }
    } catch (err) {
      console.warn(`[pricing] could not write price cache: ${(err as Error).message}`)
    }
    try {
      this.onRefresh()
    } catch (err) {
      console.error(`[pricing] onRefresh failed: ${(err as Error).message}`)
    }
    return true
  }

  loadOverrides() {
    this.overrides.clear()
    for (const row of this.db.select().from(priceOverrides).all()) {
      this.overrides.set(row.model, {
        input: row.inputPerMTok,
        output: row.outputPerMTok,
        cacheRead: row.cacheReadPerMTok,
        cacheWrite: row.cacheWritePerMTok,
      })
    }
  }

  private loadCache() {
    let text: string
    try {
      text = readFileSync(this.cachePath, 'utf8')
    } catch {
      return // no cache yet
    }
    try {
      this.table = parsePriceTable(text)
      // The table is as fresh as the download that wrote the cache.
      this.loadedAt = statSync(this.cachePath).mtimeMs
    } catch (err) {
      console.warn(`[pricing] ignoring unreadable price cache: ${(err as Error).message}`)
    }
  }

  // Finds rates for a model name, returning the entry name used.
  lookup(rawModel: string): { rates: Rates; pricedAs: string } | null {
    const override = this.overrides.get(rawModel.trim())
    if (override) return { rates: override, pricedAs: `override:${rawModel.trim()}` }

    const model = normalizeModel(rawModel)
    if (NEVER_PRICED.has(model)) return null

    const exact = this.table[model]
    if (exact && FIRST_PARTY.includes(exact.litellm_provider ?? '')) return this.toRates(model, exact)

    // Otherwise the same model listed by a reseller ("azure/gpt-6-luna"), first-party first.
    const candidates = Object.entries(this.table).filter(([key]) => key === model || key.endsWith(`/${model}`))
    candidates.sort(([, a], [, b]) => rank(a) - rank(b))
    for (const [key, entry] of candidates) {
      const priced = this.toRates(key, entry)
      if (priced) return priced
    }
    return this.fallback(model)
  }

  private fallback(model: string): { rates: Rates; pricedAs: string } | null {
    if (model.startsWith('muse-') && model.endsWith('-contributor')) {
      const base = this.lookup(model.slice(0, -'-contributor'.length))
      return base ? { rates: CONTRIBUTOR_RATES, pricedAs: 'fallback:contributor' } : null
    }
    if (model.startsWith('muse-wonder-full')) {
      const wonder = this.lookup('muse-wonder-1.0')
      return wonder ? { rates: wonder.rates, pricedAs: `fallback:${wonder.pricedAs}` } : null
    }
    return null
  }

  private toRates(key: string, e: LiteLlmEntry) {
    if (e.input_cost_per_token == null || e.output_cost_per_token == null) return null
    return {
      pricedAs: key,
      rates: {
        input: perMTok(e.input_cost_per_token),
        output: perMTok(e.output_cost_per_token),
        cacheRead: e.cache_read_input_token_cost == null ? null : perMTok(e.cache_read_input_token_cost),
        cacheWrite: e.cache_creation_input_token_cost == null ? null : perMTok(e.cache_creation_input_token_cost),
      },
    }
  }
}

// Parses LiteLLM's table. Anything that isn't a JSON object of model entries
// (an HTML error page, a truncated or garbled download) is rejected so it
// can't replace a good table; malformed entries and rates are dropped.
function parsePriceTable(text: string): Record<string, LiteLlmEntry> {
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw)) throw new Error('price table is not a JSON object')
  const table: Record<string, LiteLlmEntry> = {}
  for (const [model, value] of Object.entries(raw)) {
    if (!isObject(value)) continue
    const entry: LiteLlmEntry = {}
    if (typeof value.litellm_provider === 'string') entry.litellm_provider = value.litellm_provider
    if (typeof value.mode === 'string') entry.mode = value.mode
    for (const field of RATE_FIELDS) {
      const rate = value[field]
      if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) entry[field] = rate
    }
    // Without both required rates an entry can't price anything; dropping it
    // lets lookup fall through to another provider's listing of the model.
    if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) continue
    table[model] = entry
  }
  if (!Object.keys(table).length) throw new Error('price table has no priced models')
  return table
}

const RATE_FIELDS = ['input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost', 'cache_creation_input_token_cost'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rank(e: LiteLlmEntry) {
  const i = FIRST_PARTY.indexOf(e.litellm_provider ?? '')
  return i === -1 ? FIRST_PARTY.length : i
}

// Cost in micro-dollars. Cache tokens without a cache rate are charged at the
// plain input rate, so cached tokens are never treated as free.
export function costOf(tokens: Tokens, rates: Rates): number {
  const micros =
    (tokens.input ?? 0) * rates.input +
    (tokens.cacheRead ?? 0) * (rates.cacheRead ?? rates.input) +
    (tokens.cacheWrite ?? 0) * (rates.cacheWrite ?? rates.input) +
    (tokens.output ?? 0) * rates.output
  return Math.round(micros / 1e6)
}

// What cache reads saved versus paying full input price for them. Cache
// writes aren't counted: they cost more than plain input, not less.
export function cacheSavingsOf(tokens: Tokens, rates: Rates): number {
  const perToken = rates.input - (rates.cacheRead ?? rates.input)
  return Math.round(((tokens.cacheRead ?? 0) * perToken) / 1e6)
}
