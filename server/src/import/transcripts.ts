// Usage records from Claude Code and Codex transcript lines, for importing
// history from before the proxy collector existed.
//
// Ported from T3 Code (MIT, (c) 2026 T3 Tools Inc.),
// apps/server/src/usage/usageTranscripts.ts, trimmed to what we store.

import { isPlausibleTimestamp } from '../usage/timestamps'

export type TranscriptRecord = {
  tool: 'claude-code' | 'codex'
  timestampMs: number
  model: string
  sessionId: string
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  // Stable across re-imports, so importing twice stores each record once.
  key: string
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
// Parsed milliseconds, or null if unparseable. 0 (the epoch) is kept so the
// importer can count it as out of range.
const timestampOf = (v: unknown) => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : null
}
const obj = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)

function parseJson(line: string) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

// --- Claude Code -----------------------------------------------------------------
// Each assistant message can span several lines that repeat the same usage;
// callers must keep only the first record per key (≈2.4× overcount otherwise).

export function parseClaudeLine(line: string): TranscriptRecord | null {
  const record = parseJson(line)
  if (record?.type !== 'assistant') return null
  const message = obj(record.message)
  const usage = obj(message?.usage)
  const timestampMs = timestampOf(record.timestamp)
  const model = typeof message?.model === 'string' ? message.model : ''
  if (!usage || timestampMs === null || !model) return null

  const messageId = typeof message?.id === 'string' ? message.id : null
  const requestId = typeof record.requestId === 'string' ? record.requestId : null
  if (!messageId && !requestId) return null

  return {
    tool: 'claude-code',
    timestampMs,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    uncached: int(usage.input_tokens),
    cacheRead: int(usage.cache_read_input_tokens),
    cacheWrite: int(usage.cache_creation_input_tokens),
    output: int(usage.output_tokens),
    reasoning: 0, // folded into output by Anthropic
    key: `${messageId ?? ''}:${requestId ?? ''}`,
  }
}

// --- Codex -------------------------------------------------------------------------
// token_count events carry no model, so it's carried from the latest
// turn_context. Forked/subagent rollouts start with a burst of copied parent
// events (already counted from the parent's file), which is skipped.

const FORK_COPY_MAX_GAP_MS = 1000

export type CodexState = {
  model: string
  sessionId: string
  // Last cumulative total (or usage, for rollouts without totals): re-emit detection.
  lastProgress: string | null
  // Last per-request usage: fork copy detection, as before totals were used.
  lastUsage: string | null
  sawSessionMeta: boolean
  suppressingForkCopies: boolean
  forkAnchorMs: number
  // Events at or after this aren't imported; they mustn't claim dedup state.
  cutoffMs: number
  // Keys already given out, so distinct events that collide get a suffix.
  keys: Map<string, number>
}

export const newCodexState = (cutoffMs = Infinity): CodexState => ({
  model: '',
  sessionId: '',
  lastProgress: null,
  lastUsage: null,
  sawSessionMeta: false,
  suppressingForkCopies: false,
  forkAnchorMs: 0,
  cutoffMs,
  keys: new Map(),
})

function isFork(meta: Record<string, unknown>) {
  if (typeof meta.forked_from_id === 'string') return true
  const spawn = obj(obj(obj(meta.source)?.subagent)?.thread_spawn)
  return typeof spawn?.parent_thread_id === 'string'
}

export function parseCodexLine(line: string, state: CodexState): TranscriptRecord | null {
  const record = parseJson(line)
  const payload = obj(record?.payload)
  if (!record || !payload) return null

  if (record.type === 'session_meta') {
    // Only the first meta is this file's own session; forks repeat ancestors' metas.
    if (state.sawSessionMeta) return null
    state.sawSessionMeta = true
    const id = payload.id ?? payload.session_id
    if (typeof id === 'string') state.sessionId = id
    const at = timestampOf(record.timestamp)
    // A fork with a bad clock has no usable anchor; suppressing against it
    // would silently drop the fork's own usage, so import everything instead.
    if (at !== null && isPlausibleTimestamp(at) && isFork(payload)) {
      state.suppressingForkCopies = true
      state.forkAnchorMs = at
    }
    return null
  }

  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model
    return null
  }

  if (payload.type !== 'token_count') return null
  const info = obj(payload.info)
  const last = obj(info?.last_token_usage)
  const timestampMs = timestampOf(record.timestamp)
  if (!last || timestampMs === null || !state.model) return null

  // Identifies this request in the key (kept as before so re-imports match).
  const signature = JSON.stringify(last)
  // A re-emit repeats the cumulative total; two real requests with the same
  // usage advance it. Older rollouts without a total fall back to the usage.
  const total = obj(info?.total_token_usage)
  const progress = total ? `total:${JSON.stringify(total)}` : signature
  // A record the importer will skip (bad clock, or after the live-collection
  // cutoff) is returned for it to count, but must not touch dedup or fork
  // state: that would hide an eligible copy elsewhere in the file.
  const eligible = isPlausibleTimestamp(timestampMs) && timestampMs < state.cutoffMs
  if (eligible) {
    // Codex re-emits unchanged token_count events on some stream boundaries.
    if (progress === state.lastProgress) return null
    const sameUsage = signature === state.lastUsage
    state.lastProgress = progress
    state.lastUsage = signature

    if (state.suppressingForkCopies) {
      // A copy repeating the previous usage doesn't extend the copied burst.
      if (sameUsage) return null
      if (timestampMs - state.forkAnchorMs < FORK_COPY_MAX_GAP_MS) {
        state.forkAnchorMs = timestampMs
        return null
      }
      state.suppressingForkCopies = false
    }
  }

  const input = int(last.input_tokens)
  const cacheRead = int(last.cached_input_tokens)
  const cacheWrite = int(last.cache_write_input_tokens)
  const output = int(last.output_tokens)
  const uncached = Math.max(0, input - cacheRead - cacheWrite) // Codex input includes cached
  if (uncached + cacheRead + cacheWrite + output === 0) return null

  // Distinct requests can share a millisecond and usage. The first keeps the
  // plain key (as earlier imports stored it); later ones get "#2", "#3"...
  let key = `${state.sessionId}:${timestampMs}:${signature}`
  if (eligible) {
    const seen = (state.keys.get(key) ?? 0) + 1
    state.keys.set(key, seen)
    if (seen > 1) key = `${key}#${seen}`
  }

  return {
    tool: 'codex',
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    uncached,
    cacheRead,
    cacheWrite,
    output,
    reasoning: Math.min(output, int(last.reasoning_output_tokens)),
    key,
  }
}
