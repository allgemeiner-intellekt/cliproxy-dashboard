import { useCallback, useState } from 'react'
import { Logo } from './components/Logo'
import { ErrorBoundary, Toaster } from './components/ui'
import { getHealth, type Health } from './lib/usage'
import { isAbort, usePoll } from './lib/usePoll'
import { UsagePage } from './pages/UsagePage'

const HEALTH_EVERY_MS = 30e3

function CollectorStatus() {
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
  usePoll(check, HEALTH_EVERY_MS)

  if (unreachable) {
    return (
      <span className="status-pill mono" title="Cannot reach usage server">
        <span className="dot bad" />
        Server offline
      </span>
    )
  }

  if (!health) return null

  const { connected, lastError } = health.collector
  return (
    <span
      className="status-pill mono"
      title={connected ? 'Subscribed to CLIProxyAPI usage stream' : (lastError ?? 'Collector disconnected')}
    >
      <span className={connected ? 'dot good' : 'dot warn'} />
      {connected ? 'Live' : 'Disconnected'}
    </span>
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
  return (
    <div className="shell">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <Logo size={20} />
            CLIProxy Usage
          </div>
          <CollectorStatus />
        </div>
      </header>
      <main className="content">
        <UsagePage />
      </main>
      <Toaster />
    </div>
  )
}
