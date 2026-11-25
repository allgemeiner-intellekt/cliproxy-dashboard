// Usage: laid out like T3 Code's usage view (total, per-provider split, chart,
// totals, breakdown), styled like the rest of this dashboard.

import { ChevronRight, LoaderCircle, Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { UsageChart, type ChartGroup } from '../components/UsageChart'
import { PageHead, Segmented } from '../components/ui'
import { bucketLabel } from '../lib/chart'
import { pollIntervalMs, resolveTimeZone, useDisplayPrefs } from '../lib/prefs'
import {
  byProviderOrder,
  clearDeviceName,
  dailySeries,
  formatCount,
  formatPercent,
  formatTokens,
  formatUsd,
  getUsage,
  nameDevice,
  providerLabel,
  type MachineUsage,
  type Range,
  type ProviderUsage,
  type Totals,
  type UsageSummary,
} from '../lib/usage'
import { toast } from '../lib/toast'
import { isAbort, usePoll } from '../lib/usePoll'

type Metric = 'cost' | 'tokens'
type BreakdownKind = 'model' | 'day' | 'machine' | 'account'

const RANGE_OPTIONS: [Range, string][] = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
]
const rangeLabel = (range: Range) => RANGE_OPTIONS.find(([r]) => r === range)?.[1].toLowerCase() ?? range
const PREFS_KEY = 'cpa:usage-prefs'

type Prefs = { range: Range; metric: Metric; breakdown: BreakdownKind; chartBy: ChartGroup }
const DEFAULT_PREFS: Prefs = { range: '30d', metric: 'cost', breakdown: 'model', chartBy: 'provider' }

function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      const saved = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
      // Migrate the earlier chart preference.
      return saved.chartBy === 'tool' ? { ...saved, chartBy: 'provider' } : saved
    } catch {
      return DEFAULT_PREFS
    }
  })
  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  }
  return [prefs, update] as const
}

// --- Pieces ------------------------------------------------------------------------

// The headline and per-provider rows follow the Cost/Tokens toggle: the chosen
// metric leads, the other one moves to the secondary line.
function Hero({ summary, metric }: { summary: UsageSummary; metric: Metric }) {
  const t = summary.totals
  const unpriced = t.records ? t.unpricedRecords / t.records : 0
  const byCost = metric === 'cost'
  const share = (provider: ProviderUsage) =>
    byCost ? (t.costMicros ? provider.costMicros / t.costMicros : 0) : t.processedTokens ? provider.processedTokens / t.processedTokens : 0

  return (
    <div className="uhero">
      <div className="uhero-cost">{byCost ? formatUsd(t.costMicros) : formatTokens(t.processedTokens)}</div>
      <div className="faint uhero-sub" title={byCost && unpriced > 0 ? 'Share of requests whose model has no known price; they count as $0.' : undefined}>
        {formatCount(t.sessions)} sessions
        {byCost && ' · API estimate'}
        {byCost && unpriced > 0 && ` · ${formatPercent(unpriced)} unpriced`}
      </div>

      <div className="utools">
        {[...summary.providers]
          .sort((a, b) => byProviderOrder(a.provider, b.provider))
          .map((provider) => (
            <div key={provider.provider} className="utool">
              <div className="utool-line">
                <ProviderMark of={provider.provider} />
                <span className="utool-name">{providerLabel(provider.provider)}</span>
                <span className="mono utool-cost">{byCost ? formatUsd(provider.costMicros) : formatTokens(provider.processedTokens)}</span>
              </div>
              <div className="faint utool-sub">
                {formatCount(provider.sessions)} sessions · {formatPercent(share(provider))} of {byCost ? 'cost' : 'tokens'} ·{' '}
                {byCost ? `${formatTokens(provider.processedTokens)} tokens` : formatUsd(provider.costMicros)}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

function TotalsRow({ totals }: { totals: Totals }) {
  const tiles: [string, string][] = [
    ['Processed tokens', formatTokens(totals.processedTokens)],
    ['Cached input', formatTokens(totals.cachedTokens)],
    ['Uncached input', formatTokens(totals.uncachedTokens)],
    ['Output', formatTokens(totals.outputTokens)],
    ['Cache savings', formatUsd(totals.cacheSavingsMicros)],
  ]
  return (
    <div className="panel utotals">
      {tiles.map(([label, value]) => (
        <div key={label} className="utotal">
          <div className="eyebrow">{label}</div>
          <div className="mono utotal-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

// Cost, share and tokens columns shared by every breakdown except Day.
const isUnpriced = (row: Totals) => row.records > 0 && row.unpricedRecords >= row.records
const shareOf = (row: Totals, total: number, metric: Metric) =>
  total ? (metric === 'cost' ? row.costMicros : row.processedTokens) / total : 0

function CostCells({ row, total, metric }: { row: Totals; total: number; metric: Metric }) {
  const unknown = isUnpriced(row)
  return (
    <>
      <td className="mono num">{unknown ? <span className="faint">Unpriced</span> : formatUsd(row.costMicros)}</td>
      <td className="mono num faint ushare">{unknown && metric === 'cost' ? '—' : formatPercent(shareOf(row, total, metric))}</td>
      <td className="mono num utokens">{formatTokens(row.processedTokens)}</td>
    </>
  )
}

// Phones hide the Share and Tokens columns; this line under the name carries them.
function RowMeta({ row, share }: { row: Totals; share: number }) {
  return (
    <div className="umeta mono faint">
      {formatTokens(row.processedTokens)} tokens · {formatPercent(share)}
    </div>
  )
}

function MachineName({ machine, onChange }: { machine: MachineUsage; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(machine.name)

  // Renaming applies to every identity this row was recognized by.
  const save = async () => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === machine.name) return
    try {
      await Promise.all(machine.identities.map((i) => nameDevice(i.kind, i.value, name)))
      onChange()
    } catch (err) {
      toast(`Couldn’t rename: ${(err as Error).message}`)
    }
  }

  const reset = async () => {
    await Promise.all(machine.identities.map((i) => clearDeviceName(i.kind, i.value))).catch((err) =>
      toast(`Couldn’t reset: ${err.message}`),
    )
    onChange()
  }

  if (editing) {
    return (
      <input
        className="input udev-input"
        aria-label={`Name for ${machine.name}`}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <span className="udev">
      <button
        className="udev-name"
        title="Rename"
        aria-label={`Rename ${machine.name}`}
        onClick={() => {
          setDraft(machine.name)
          setEditing(true)
        }}
      >
        {machine.name}
        <Pencil size={12} className="faint" />
      </button>
      {machine.nameSource === 'tailscale' && <span className="tag">tailscale</span>}
      {machine.nameSource === 'custom' && (
        <button className="udev-reset faint" title="Use the Tailscale name again" aria-label={`Use the Tailscale name for ${machine.name} again`} onClick={reset}>
          <RotateCcw size={12} />
        </button>
      )}
    </span>
  )
}

// A machine row that expands to show its models. Model shares are of that
// machine's total, with a thin bar so the mix reads at a glance.
function MachineRows({ machine, total, metric, onChange }: { machine: MachineUsage; total: number; metric: Metric; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const machineTotal = metric === 'cost' ? machine.costMicros : machine.processedTokens
  const models = metric === 'tokens' ? [...machine.models].sort((a, b) => b.processedTokens - a.processedTokens) : machine.models

  return (
    <>
      <tr
        className={open ? 'uexpand open' : 'uexpand'}
        // The whole row toggles, except the name, which is for renaming.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.udev, .udev-input')) setOpen(!open)
        }}
      >
        <td>
          <span className="ucell-name">
            <button
              className="uchevron"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} models for ${machine.name}`}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(!open)
              }}
            >
              <ChevronRight size={14} />
            </button>
            <MachineName machine={machine} onChange={onChange} />
          </span>
          <RowMeta row={machine} share={shareOf(machine, total, metric)} />
        </td>
        <CostCells row={machine} total={total} metric={metric} />
      </tr>
      {open &&
        models.map((m) => {
          const value = metric === 'cost' ? m.costMicros : m.processedTokens
          const share = machineTotal ? value / machineTotal : 0
          const unknown = m.records > 0 && m.unpricedRecords >= m.records
          return (
            <tr key={`${m.provider}:${m.model}`} className="usub">
              <td>
                <span className="ucell-name usub-name">
                  <ProviderMark of={m.provider} size={12} />
                  <span className="mono">{m.model}</span>
                </span>
                <RowMeta row={m} share={share} />
              </td>
              <td className="mono num">{unknown ? <span className="faint">Unpriced</span> : formatUsd(m.costMicros)}</td>
              <td className="mono num faint ushare" title="Share of this machine">
                {unknown && metric === 'cost' ? (
                  '—'
                ) : (
                  <span className="usub-share">
                    <span className="usub-bar">
                      <span style={{ width: `${share * 100}%` }} />
                    </span>
                    {formatPercent(share)}
                  </span>
                )}
              </td>
              <td className="mono num utokens">{formatTokens(m.processedTokens)}</td>
            </tr>
          )
        })}
    </>
  )
}

function Breakdown({ summary, kind, metric, onChange }: { summary: UsageSummary; kind: BreakdownKind; metric: Metric; onChange: () => void }) {
  const total = metric === 'cost' ? summary.totals.costMicros : summary.totals.processedTokens
  const sort = <T extends Totals>(rows: T[]) =>
    metric === 'tokens' ? [...rows].sort((a, b) => b.processedTokens - a.processedTokens) : rows

  if (kind === 'day') {
    const providers = summary.providers.map((t) => t.provider).sort(byProviderOrder)
    const series = dailySeries(summary)
    const rows = [...series].reverse().filter((b) => Object.keys(b.providers).length > 0)
    return (
      <table className="utable">
        <thead>
          <tr>
            <th>{summary.range === '24h' ? 'Hour' : 'Day'}</th>
            {providers.map((t) => (
              <th key={t} className="num utoolcol">
                {providerLabel(t)}
              </th>
            ))}
            <th className="num">Total</th>
            {/* Total follows the metric; this column carries the other one. */}
            <th className="num">{metric === 'cost' ? 'Tokens' : 'Cost'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const cost = providers.reduce((n, t) => n + (b.providers[t]?.costMicros ?? 0), 0)
            const tokens = providers.reduce((n, t) => n + (b.providers[t]?.tokens ?? 0), 0)
            return (
              <tr key={String(b.key)}>
                <td className="mono">{bucketLabel(b.key, true, summary.timeZone)}</td>
                {providers.map((t) => (
                  <td key={t} className="mono num faint utoolcol">
                    {!b.providers[t] ? '—' : metric === 'cost' ? formatUsd(b.providers[t].costMicros) : formatTokens(b.providers[t].tokens)}
                  </td>
                ))}
                <td className="mono num">{metric === 'cost' ? formatUsd(cost) : formatTokens(tokens)}</td>
                <td className="mono num faint">{metric === 'cost' ? formatTokens(tokens) : formatUsd(cost)}</td>
              </tr>
            )
          })}
          {rows.length === 0 && <EmptyRow cols={providers.length + 3} />}
        </tbody>
      </table>
    )
  }

  const heading = { model: 'Model', machine: 'Machine', account: 'Account' }[kind]
  return (
    <table className="utable">
      <thead>
        <tr>
          <th className="ucol-name">{heading}</th>
          <th className="num">Cost</th>
          <th className="num ushare">Share</th>
          <th className="num utokens">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {kind === 'model' &&
          sort(summary.byModel).map((m) => (
            <tr key={`${m.provider}:${m.model}`}>
              <td>
                <span className="ucell-name">
                  <ProviderMark of={m.provider} />
                  <span className="mono">{m.model}</span>
                </span>
                <RowMeta row={m} share={shareOf(m, total, metric)} />
              </td>
              <CostCells row={m} total={total} metric={metric} />
            </tr>
          ))}
        {kind === 'machine' &&
          sort(summary.byMachine).map((m) => <MachineRows key={m.name} machine={m} total={total} metric={metric} onChange={onChange} />)}
        {kind === 'account' &&
          sort(summary.byAccount).map((a) => (
            <tr key={a.name}>
              <td>
                {a.name}
                <RowMeta row={a} share={shareOf(a, total, metric)} />
              </td>
              <CostCells row={a} total={total} metric={metric} />
            </tr>
          ))}
        {summary.totals.records === 0 && <EmptyRow cols={4} />}
      </tbody>
    </table>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="faint">
        No activity in this window.
      </td>
    </tr>
  )
}

// --- Page ----------------------------------------------------------------------------

// Placeholder shaped like the hero, chart and totals, shown until the first load.
function UsageSkeleton() {
  return (
    <div className="uskeleton" role="status">
      <span className="sr-only">Loading usage</span>
      <div className="utop" aria-hidden>
        <div>
          <div className="skel skel-hero" />
          <div className="skel skel-line" style={{ width: '60%' }} />
          <div className="utools">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <div className="skel skel-line" />
                <div className="skel skel-line" style={{ width: '70%' }} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="skel skel-line" style={{ width: '30%', marginBottom: 12 }} />
          <div className="skel skel-chart" />
        </div>
      </div>
      <section className="section" aria-hidden>
        <div className="skel skel-totals" />
      </section>
    </div>
  )
}

export function UsagePage({ refreshTick = 0 }: { refreshTick?: number } = {}) {
  const [prefs, setPrefs] = usePrefs()
  const [displayPrefs] = useDisplayPrefs()
  const tz = resolveTimeZone(displayPrefs.timeZone)
  // Results are kept with the range they were requested for, so a switch shows
  // the old numbers as stale (not as the new range) until the new ones arrive.
  const [data, setData] = useState<{ range: Range; summary: UsageSummary } | null>(null)
  const [error, setError] = useState<{ range: Range; message: string } | null>(null)
  const [busy, setBusy] = useState(false) // a request is in flight

  const load = useCallback(
    async (signal: AbortSignal) => {
      const range = prefs.range
      setBusy(true)
      try {
        const summary = await getUsage(range, signal, tz)
        if (signal.aborted) return
        setData({ range, summary })
        setError(null)
      } catch (err) {
        if (signal.aborted || isAbort(err)) return
        setError({ range, message: (err as Error).message })
      } finally {
        // An aborted run was replaced by a newer one, which owns `busy` now.
        if (!signal.aborted) setBusy(false)
      }
    },
    [prefs.range, tz],
  )
  const refresh = usePoll(load, pollIntervalMs(displayPrefs.pollInterval))

  const prevTick = useRef(refreshTick)
  useEffect(() => {
    if (refreshTick !== prevTick.current) {
      prevTick.current = refreshTick
      refresh()
    }
  }, [refreshTick, refresh])

  const summary = data?.summary ?? null
  const failed = error?.range === prefs.range ? error.message : null
  const stale = data !== null && data.range !== prefs.range
  const chartTitle = `${summary?.bucket === 'hour' ? 'Hourly' : 'Daily'} ${prefs.metric === 'cost' ? 'cost' : 'processed tokens'}`

  return (
    <div className="page">
      <PageHead title="Usage">
        <Segmented
          label="Metric"
          value={prefs.metric}
          onChange={(metric) => setPrefs({ metric })}
          options={[
            ['cost', 'Cost'],
            ['tokens', 'Tokens'],
          ]}
        />
        <Segmented className="range-seg" label="Time range" value={prefs.range} onChange={(range) => setPrefs({ range })} options={RANGE_OPTIONS} />
        {/* Phones get a compact dropdown instead of five buttons. */}
        <select
          className="input range-select"
          aria-label="Time range"
          value={prefs.range}
          onChange={(e) => setPrefs({ range: e.target.value as Range })}
        >
          {RANGE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {/* Any refresh, including polls and the one on returning to the tab;
            a range switch has its own, more specific notice below. */}
        <span className="uloading" role="status">
          {summary && busy && !stale && (
            <>
              <LoaderCircle size={14} className="spin" aria-hidden />
              <span className="sr-only">Loading</span>
            </>
          )}
        </span>
      </PageHead>

      {failed && (
        <div className="uerror" role="alert">
          <span className="error-text">Couldn’t load usage: {failed}</span>
          {/* Disabled while any load (e.g. the one on returning to the tab) is
              running, so clicking doesn't abort a recovery already underway. */}
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setError(null)
              refresh()
            }}
          >
            {busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : null}
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {!summary && !failed && <UsageSkeleton />}

      {/* Says in words that the numbers below are for the previous range. */}
      {data && stale && !failed && (
        <p className="ustale" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden />
          Loading {rangeLabel(prefs.range)}. Still showing {rangeLabel(data.range)}.
        </p>
      )}

      {/* A failed switch hides the previous range's numbers rather than leave them up. */}
      {summary && !(stale && failed) && (
        <div className={stale ? 'ubody is-stale' : 'ubody'}>
          <div className="utop">
            <Hero summary={summary} metric={prefs.metric} />
            <div>
              <div className="utop-head">
                <div className="eyebrow">{chartTitle}</div>
                <Segmented
                  label="Chart grouping"
                  className="seg-small"
                  value={prefs.chartBy}
                  onChange={(chartBy) => setPrefs({ chartBy })}
                  options={[
                    ['provider', 'By provider'],
                    ['machine', 'By machine'],
                  ]}
                />
              </div>
              <UsageChart summary={summary} metric={prefs.metric} by={prefs.chartBy} />
            </div>
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Totals</h2>
            </div>
            <TotalsRow totals={summary.totals} />
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Breakdown</h2>
              <div className="page-actions">
                <Segmented
                  label="Breakdown"
                  value={prefs.breakdown}
                  onChange={(breakdown) => setPrefs({ breakdown })}
                  options={[
                    ['model', 'Model'],
                    ['day', summary.range === '24h' ? 'Hour' : 'Day'],
                    ['machine', 'Machine'],
                    ['account', 'Account'],
                  ]}
                />
              </div>
            </div>
            <div className="panel utable-wrap">
              <Breakdown summary={summary} kind={prefs.breakdown} metric={prefs.metric} onChange={refresh} />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
