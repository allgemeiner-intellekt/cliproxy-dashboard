import { ChevronRight, CircleAlert, Database, Plug, RefreshCw, ShieldAlert, SlidersHorizontal, Table2, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useDisplayPrefs, type DisplayPrefs } from '../lib/prefs'
import { toast } from '../lib/toast'
import { isAbort } from '../lib/usePoll'
import {
  formatCount,
  getSystem,
  reconnectCollector,
  refreshPricing,
  type SystemInfo,
  type UsedModelPricing,
} from '../lib/usage'
import { Logo } from './Logo'
import { ProviderMark } from './ProviderMark'
import { Segmented } from './ui'

export type SettingsPane = 'connection' | 'pricing' | 'preferences' | 'storage'

const PANE_TITLES: Record<SettingsPane, string> = {
  connection: 'CPA Connection',
  pricing: 'Model Pricing',
  preferences: 'Preferences',
  storage: 'Storage & Runtime',
}

function formatRelative(ts: number | null) {
  if (!ts) return 'Never'
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  const remMin = diffMin % 60
  if (diffHr < 24) return remMin ? `${diffHr}h ${remMin}m ago` : `${diffHr}h ago`
  return `${Math.round(diffHr / 24)}d ago`
}

function formatDate(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Rates arrive in micro-dollars per million tokens (1_000_000 = $1.00 / 1M).
function formatRateMicros(micros: number | null | undefined) {
  if (micros === null || micros === undefined) return '—'
  const usd = micros / 1e6
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd === 0) return '$0.00'
  return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

function ConnectionPane({
  system,
  reconnecting,
  onReconnect,
}: {
  system: SystemInfo
  reconnecting: boolean
  onReconnect: () => void
}) {
  const { collector } = system
  const dotClass = collector.connected ? 'dot good' : collector.authFailed ? 'dot bad' : 'dot warn'
  const stateLabel = collector.connected ? 'Live' : collector.authFailed ? 'Auth failed' : 'Disconnected'

  return (
    <>
      <div className="panel">
        <div className="group-list">
          <div className="group-row">
            <div>
              <div className="group-label">Status</div>
              <div className="group-desc">
                {collector.connected
                  ? `Subscribed since ${formatDateTime(collector.since)}`
                  : `Disconnected since ${formatDateTime(collector.downSince)}`}
              </div>
            </div>
            <span className="mono group-val group-status">
              <span className={dotClass} />
              {stateLabel}
            </span>
          </div>

          <div className="group-row">
            <div>
              <div className="group-label">CPA Target</div>
              <div className="group-desc">Plaintext RESP usage Pub/Sub endpoint</div>
            </div>
            <span className="mono group-val">{collector.target ?? 'Unknown'}</span>
          </div>

          <div className="group-row">
            <div>
              <div className="group-label">Management Key</div>
              <div className="group-desc">Used server-side only to authenticate subscription</div>
            </div>
            <span className="mono group-val">{collector.keyConfigured ? 'Configured (env)' : 'Not set'}</span>
          </div>

          <div className="group-row">
            <div>
              <div className="group-label">Collected This Run</div>
              <div className="group-desc">Last record received {formatRelative(collector.lastRecordAt)}</div>
            </div>
            <span className="mono group-val">{formatCount(collector.stored)} requests</span>
          </div>
        </div>

        {collector.lastError && (
          <div className={`strip-alert ${collector.authFailed ? 'is-bad' : 'is-warn'}`} role="alert">
            <span className="strip-alert-msg mono">
              {collector.authFailed ? <ShieldAlert size={14} /> : <CircleAlert size={14} />}
              {collector.lastError}
            </span>
            <button type="button" className="btn" disabled={reconnecting} onClick={onReconnect}>
              <RefreshCw size={12} className={reconnecting ? 'spin' : undefined} />
              {reconnecting ? 'Reconnecting…' : 'Reconnect'}
            </button>
          </div>
        )}
      </div>

      <p className="env-hint">
        Target and key are read from <code>CPA_TARGET</code> and <code>CPA_MANAGEMENT_KEY</code> in{' '}
        <code>.env.local</code> or container environment.
      </p>
    </>
  )
}

function PricingRow({ row }: { row: UsedModelPricing }) {
  const [open, setOpen] = useState(false)
  const tiers = row.rates?.tiers ?? []
  const hasTiers = tiers.length > 0

  return (
    <Fragment>
      <tr
        className={hasTiers ? (open ? 'uexpand open' : 'uexpand') : undefined}
        onClick={hasTiers ? () => setOpen((v) => !v) : undefined}
      >
        <td>
          <span className="ucell-name">
            {hasTiers ? (
              <button
                type="button"
                className="uchevron"
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} long-context tiers for ${row.model}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen((v) => !v)
                }}
              >
                <ChevronRight size={14} />
              </button>
            ) : (
              <span style={{ width: 14, display: 'inline-block' }} />
            )}
            <ProviderMark of={row.provider} />
            <span className="mono">{row.model}</span>
            {hasTiers && <span className="tag tag-accent">&gt;{Math.round(tiers[0].aboveTokens / 1000)}k</span>}
          </span>
        </td>
        <td>
          {row.matchKind === 'unpriced' ? (
            <span
              className="tag tag-warn"
              title={
                row.unpricedRequests > 0
                  ? `${formatCount(row.unpricedRequests)} stored requests have no recorded price`
                  : 'Not currently listed in the LiteLLM catalog; stored requests already have prices'
              }
            >
              {row.unpricedRequests > 0 ? `Unpriced · ${formatCount(row.unpricedRequests)}` : 'No catalog rate'}
            </span>
          ) : row.matchKind === 'fallback' ? (
            <span className="tag" title="Priced using fallback sibling rule">
              {row.pricedAs}
            </span>
          ) : (
            <span className="mono faint">{row.pricedAs}</span>
          )}
        </td>
        <td className="mono num">{formatRateMicros(row.rates?.input)}</td>
        <td className="mono num">{formatRateMicros(row.rates?.output)}</td>
        <td className="mono num faint">{formatRateMicros(row.rates?.cacheRead)}</td>
        <td className="mono num faint">{formatRateMicros(row.rates?.cacheWrite)}</td>
      </tr>
      {hasTiers &&
        open &&
        tiers.map((tier) => (
          <tr key={tier.aboveTokens} className="tier-row">
            <td>
              <span className="mono">Prompt &gt; {Math.round(tier.aboveTokens / 1000)}k tokens</span>
            </td>
            <td className="faint">Long-context tier</td>
            <td className="mono num">{formatRateMicros(tier.rates.input)}</td>
            <td className="mono num">{formatRateMicros(tier.rates.output)}</td>
            <td className="mono num">{formatRateMicros(tier.rates.cacheRead)}</td>
            <td className="mono num">{formatRateMicros(tier.rates.cacheWrite)}</td>
          </tr>
        ))}
    </Fragment>
  )
}

function PricingPane({ system }: { system: SystemInfo }) {
  const { pricing } = system
  const [filter, setFilter] = useState<'all' | 'unpriced'>('all')
  const [query, setQuery] = useState('')

  const unpricedCount = pricing.usedModels.filter((m) => m.unpricedRequests > 0).length
  const visible = pricing.usedModels.filter((m) => {
    if (filter === 'unpriced' && m.unpricedRequests === 0) return false
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return m.model.toLowerCase().includes(q) || (m.pricedAs ?? '').toLowerCase().includes(q)
    }
    return true
  })

  return (
    <>
      <div className="panel">
        <div className="pricing-tools">
          <Segmented
            label="Filter models"
            className="seg-small"
            value={filter}
            options={[
              ['all', `Used (${pricing.usedModels.length})`],
              ['unpriced', `Unpriced (${unpricedCount})`],
            ]}
            onChange={setFilter}
          />
          <input
            className="input pricing-search"
            type="search"
            placeholder="Filter model…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="utable-wrap">
          <table className="utable">
            <thead>
              <tr>
                <th>Model</th>
                <th>LiteLLM Entry</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache Read</th>
                <th className="num">Cache Write</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="faint settings-empty">
                    {pricing.usedModels.length === 0
                      ? 'No usage records yet.'
                      : filter === 'unpriced'
                        ? 'Every used model has active pricing.'
                        : 'No matching models.'}
                  </td>
                </tr>
              ) : (
                visible.map((row) => <PricingRow key={`${row.provider}:${row.model}`} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="env-hint">
        Rates are USD / 1M tokens from LiteLLM’s public table (cached at <code>{pricing.cachePath}</code>, updated{' '}
        {formatRelative(pricing.loadedAt)}). Refresh downloads the latest table and backfills unpriced requests.
      </p>
    </>
  )
}

function PreferencesPane({
  prefs,
  onChange,
}: {
  prefs: DisplayPrefs
  onChange: (patch: Partial<DisplayPrefs>) => void
}) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  return (
    <>
      <div className="panel group-list">
        <div className="group-row">
          <div>
            <div className="group-label">Auto-refresh</div>
            <div className="group-desc">How often Usage and health poll for updates</div>
          </div>
          <Segmented
            label="Auto-refresh interval"
            value={prefs.pollInterval}
            options={[
              ['15', '15s'],
              ['30', '30s'],
              ['60', '60s'],
              ['off', 'Off'],
            ]}
            onChange={(pollInterval) => onChange({ pollInterval })}
          />
        </div>

        <div className="group-row">
          <div>
            <div className="group-label">Reporting time zone</div>
            <div className="group-desc">Controls daily chart buckets and day-by-day totals</div>
          </div>
          <select
            className="input pref-select"
            aria-label="Reporting time zone"
            value={prefs.timeZone}
            onChange={(e) => onChange({ timeZone: e.target.value })}
          >
            <option value="auto">Browser ({browserTz})</option>
            <option value="UTC">UTC</option>
            <option value="Asia/Shanghai">Asia/Shanghai</option>
            <option value="America/Los_Angeles">America/Los_Angeles</option>
            <option value="America/New_York">America/New_York</option>
            <option value="Europe/London">Europe/London</option>
            <option value="Asia/Tokyo">Asia/Tokyo</option>
          </select>
        </div>
      </div>
      <p className="env-hint">Preferences are stored in this browser only.</p>
    </>
  )
}

function StoragePane({ system }: { system: SystemInfo }) {
  const { storage, runtime, pricing } = system

  return (
    <div className="panel group-list">
      <div className="group-row">
        <div>
          <div className="group-label">SQLite Database</div>
          <div className="group-desc">
            {formatBytes(storage.dbSizeBytes)} main · {formatBytes(storage.walSizeBytes)} WAL
          </div>
        </div>
        <span className="mono group-val">{storage.dbPath}</span>
      </div>

      <div className="group-row">
        <div>
          <div className="group-label">Stored Requests</div>
          <div className="group-desc">
            {storage.earliestAt ? `${formatDate(storage.earliestAt)} – ${formatDate(storage.latestAt)}` : 'No requests stored'}
          </div>
        </div>
        <span className="mono group-val">
          {formatCount(storage.totalRequests)}
          {storage.unpricedRequests > 0 ? ` (${formatCount(storage.unpricedRequests)} unpriced)` : ''}
        </span>
      </div>

      <div className="group-row">
        <div>
          <div className="group-label">Price Cache</div>
          <div className="group-desc">{formatCount(pricing.totalCatalogModels)} catalog entries</div>
        </div>
        <span className="mono group-val">{pricing.cachePath}</span>
      </div>

      <div className="group-row">
        <div>
          <div className="group-label">Server Listener</div>
          <div className="group-desc">Allowed hosts: {runtime.allowedHosts.join(', ')}</div>
        </div>
        <span className="mono group-val">{runtime.listenAddress ? `http://${runtime.listenAddress}` : '—'}</span>
      </div>
    </div>
  )
}

export function SettingsModal({
  open,
  initialPane,
  onClose,
  onDataChanged,
}: {
  open: boolean
  initialPane: SettingsPane
  onClose: () => void
  onDataChanged: () => void
}) {
  if (!open) return null
  return <SettingsModalContent initialPane={initialPane} onClose={onClose} onDataChanged={onDataChanged} />
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function isElementVisible(el: HTMLElement, stopAt: HTMLElement): boolean {
  let cur: HTMLElement | null = el
  while (cur && cur !== stopAt) {
    const style = window.getComputedStyle(cur)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    cur = cur.parentElement
  }
  return true
}

function SettingsModalContent({
  initialPane,
  onClose,
  onDataChanged,
}: {
  initialPane: SettingsPane
  onClose: () => void
  onDataChanged: () => void
}) {
  const [pane, setPane] = useState<SettingsPane>(initialPane)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)
  const [refreshingPrices, setRefreshingPrices] = useState(false)
  const [prefs, setPrefs] = useDisplayPrefs()

  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  const loadSeqRef = useRef(0)
  const loadAbortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const seq = ++loadSeqRef.current
    try {
      const next = await getSystem(controller.signal)
      if (controller.signal.aborted || seq !== loadSeqRef.current) return
      setSystem(next)
      setError(null)
    } catch (err) {
      if (controller.signal.aborted || isAbort(err) || seq !== loadSeqRef.current) return
      setError((err as Error).message)
    } finally {
      if (!controller.signal.aborted && seq === loadSeqRef.current) setLoading(false)
    }
  }, [])

  // Fetch initial snapshot on mount and abort any in-flight request on unmount.
  useEffect(() => {
    const controller = new AbortController()
    loadAbortRef.current = controller
    const seq = ++loadSeqRef.current
    getSystem(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || seq !== loadSeqRef.current) return
        setSystem(next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbort(err) || seq !== loadSeqRef.current) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!controller.signal.aborted && seq === loadSeqRef.current) setLoading(false)
      })
    return () => {
      controller.abort()
      loadAbortRef.current?.abort()
    }
  }, [])

  // Initial focus inside dialog, focus trap on Tab/Shift+Tab (skipping elements
  // hidden by responsive CSS), Escape to close, and restore focus on unmount.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const visibleFocusables = () =>
      dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => isElementVisible(el, dialog)) : []

    const activeNav = dialog?.querySelector<HTMLElement>('.settings-nav-item[aria-current="true"]')
    const initialTarget =
      (activeNav && dialog && isElementVisible(activeNav, dialog) ? activeNav : visibleFocusables()[0]) ?? dialog
    initialTarget?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const focusables = visibleFocusables()
      if (focusables.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (!active || active === first || !dialog.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (!active || active === last || !dialog.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  const handleReconnect = async () => {
    setReconnecting(true)
    try {
      const res = await reconnectCollector()
      if (res.ok) {
        toast('Reconnected to CLIProxyAPI usage stream', 'info')
      } else if (res.collector?.lastError) {
        toast(`Reconnect failed: ${res.collector.lastError}`)
      } else {
        toast('Reconnect triggered; waiting for CLIProxyAPI', 'info')
      }
      await load()
      onDataChanged()
    } catch (err) {
      toast(`Reconnect failed: ${(err as Error).message}`)
    } finally {
      setReconnecting(false)
    }
  }

  const handleRefreshPrices = async () => {
    setRefreshingPrices(true)
    try {
      const res = await refreshPricing()
      if (res.ok) {
        toast(`Price table refreshed (${formatCount(res.totalCatalogModels)} models)`, 'info')
        await load()
        onDataChanged()
      } else if (res.downloaded && !res.repriced) {
        toast(`Price table updated, but repricing failed: ${res.error ?? 'unknown error'}`)
        await load()
        onDataChanged()
      } else {
        toast('Could not download price table; kept cached table')
      }
    } catch (err) {
      toast(`Price refresh failed: ${(err as Error).message}`)
    } finally {
      setRefreshingPrices(false)
    }
  }

  const collector = system?.collector
  const dotClass = !collector
    ? 'dot'
    : collector.connected
      ? 'dot good'
      : collector.authFailed
        ? 'dot bad'
        : 'dot warn'
  const pillLabel = !collector
    ? 'Loading'
    : collector.connected
      ? 'Live'
      : collector.authFailed
        ? 'Auth error'
        : 'Disconnected'
  const unpricedCount = system?.pricing.usedModels.filter((m) => m.unpricedRequests > 0).length ?? 0

  const navItems: { id: SettingsPane; label: string; icon: typeof Plug; badge?: string }[] = [
    { id: 'connection', label: 'Connection', icon: Plug },
    { id: 'pricing', label: 'Model Pricing', icon: Table2, badge: unpricedCount ? `${unpricedCount}` : undefined },
    { id: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
    { id: 'storage', label: 'Storage', icon: Database },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal-shell"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-rail" aria-label="Settings sections">
          <button
            type="button"
            className="settings-instance"
            aria-current={pane === 'connection' ? 'true' : undefined}
            onClick={() => setPane('connection')}
          >
            <Logo size={18} />
            <div className="settings-instance-meta">
              <div className="settings-instance-title">
                <span className={dotClass} />
                CPA {pillLabel}
              </div>
              <div className="mono settings-instance-sub">
                {collector?.target ? collector.target.replace(/^http:\/\//, '') : '—'}
              </div>
            </div>
          </button>

          <nav className="settings-nav">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className="settings-nav-item"
                  aria-current={pane === item.id ? 'true' : undefined}
                  onClick={() => setPane(item.id)}
                >
                  <Icon size={14} className="faint" aria-hidden />
                  <span>{item.label}</span>
                  {item.badge && <span className="settings-nav-badge">{item.badge}</span>}
                </button>
              )
            })}
          </nav>

          <div className="settings-rail-foot mono">CLIProxy Usage</div>
        </aside>

        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2 className="settings-pane-title">{PANE_TITLES[pane]}</h2>
            <div className="settings-pane-actions">
              {pane === 'connection' && system && (
                <button type="button" className="btn" disabled={reconnecting} onClick={handleReconnect}>
                  <RefreshCw size={12} className={reconnecting ? 'spin' : undefined} />
                  {reconnecting ? 'Reconnecting…' : 'Reconnect'}
                </button>
              )}
              {pane === 'pricing' && system && (
                <button type="button" className="btn" disabled={refreshingPrices} onClick={handleRefreshPrices}>
                  <RefreshCw size={12} className={refreshingPrices ? 'spin' : undefined} />
                  {refreshingPrices ? 'Refreshing…' : 'Refresh & Reprice'}
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="settings-pane-body">
            {pane === 'preferences' ? (
              <PreferencesPane prefs={prefs} onChange={setPrefs} />
            ) : error && !system ? (
              <div className="panel settings-error" role="alert">
                <span className="error-text">Couldn’t load system info: {error}</span>
                <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
                  Retry
                </button>
              </div>
            ) : !system ? (
              <div className="panel settings-empty faint">Loading system info…</div>
            ) : pane === 'connection' ? (
              <ConnectionPane system={system} reconnecting={reconnecting} onReconnect={handleReconnect} />
            ) : pane === 'pricing' ? (
              <PricingPane system={system} />
            ) : (
              <StoragePane system={system} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
