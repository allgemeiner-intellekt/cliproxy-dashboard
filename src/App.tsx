import { Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Logo } from './components/Logo'
import { SettingsModal, type SettingsPane } from './components/SettingsModal'
import { ThemeMenu } from './components/ThemeMenu'
import { ErrorBoundary, Toaster } from './components/ui'
import { pollIntervalMs, useDisplayPrefs } from './lib/prefs'
import { getHealth, type Health } from './lib/usage'
import { isAbort, usePoll } from './lib/usePoll'
import { UsagePage } from './pages/UsagePage'

function CollectorStatus({
  everyMs,
  refreshTick,
  onOpenConnection,
}: {
  everyMs: number
  refreshTick: number
  onOpenConnection: () => void
}) {
  const [health, setHealth] = useState<Health | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const check = useCallback(async (signal: AbortSignal) => {
    try {
      const next = await getHealth(signal)
      if (signal.aborted) return
      setHealth(next)
      setUnreachable(false)
    } catch (err) {
      if (signal.aborted || isAbort(err)) return
      setUnreachable(true)
    }
  }, [])
  const refresh = usePoll(check, everyMs)

  const prevTick = useRef(refreshTick)
  useEffect(() => {
    if (refreshTick !== prevTick.current) {
      prevTick.current = refreshTick
      refresh()
    }
  }, [refreshTick, refresh])

  if (unreachable) {
    return (
      <button
        type="button"
        className="status-pill-btn mono"
        title="Cannot reach usage server"
        onClick={onOpenConnection}
      >
        <span className="dot bad" />
        Server offline
      </button>
    )
  }

  if (!health) return null

  const { connected, authFailed, lastError } = health.collector
  const dotClass = connected ? 'dot good' : authFailed ? 'dot bad' : 'dot warn'
  const label = connected ? 'Live' : authFailed ? 'Auth error' : 'Disconnected'

  return (
    <button
      type="button"
      className="status-pill-btn mono"
      title={connected ? 'Subscribed to CLIProxyAPI usage stream' : (lastError ?? 'Collector disconnected')}
      onClick={onOpenConnection}
    >
      <span className={dotClass} />
      {label}
    </button>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  )
}

function Shell() {
  const [prefs] = useDisplayPrefs()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState<SettingsPane>('connection')
  const [refreshTick, setRefreshTick] = useState(0)

  const openSettings = useCallback((pane: SettingsPane) => {
    setSettingsPane(pane)
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const handleDataChanged = useCallback(() => setRefreshTick((n) => n + 1), [])

  return (
    <div className="shell">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <Logo size={20} />
            CLIProxy Usage
          </div>
          <div className="header-actions">
            <CollectorStatus
              everyMs={pollIntervalMs(prefs.pollInterval)}
              refreshTick={refreshTick}
              onOpenConnection={() => openSettings('connection')}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Settings"
              aria-pressed={settingsOpen}
              title="Settings"
              onClick={() => openSettings('connection')}
            >
              <Settings size={14} aria-hidden />
            </button>
            <ThemeMenu />
          </div>
        </div>
      </header>
      <main className="content">
        <UsagePage refreshTick={refreshTick} />
      </main>
      <SettingsModal
        open={settingsOpen}
        initialPane={settingsPane}
        onClose={closeSettings}
        onDataChanged={handleDataChanged}
      />
      <Toaster />
    </div>
  )
}
