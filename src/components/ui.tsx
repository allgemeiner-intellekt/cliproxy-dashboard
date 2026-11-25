import { CircleAlert, RotateCw, X } from 'lucide-react'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { addToast, INFO_TOAST_MS, onToast, visibleToasts, type ToastItem } from '../lib/toast'

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="mono faint">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  )
}

// A row of toggle buttons. `label` names the group for screen readers.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={label}>
      {options.map(([v, label]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// Toasts stack, newest at the bottom; see lib/toast for which ones show.
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    let nextId = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const unsubscribe = onToast((msg, kind) => {
      const id = ++nextId
      setItems((prev) => addToast(prev, { id, kind, msg }))
      if (kind === 'info') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          setItems((prev) => prev.filter((t) => t.id !== id))
        }, INFO_TOAST_MS)
        timers.add(timer)
      }
    })
    return () => {
      unsubscribe()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])

  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id))
  const { shown, queued } = visibleToasts(items)

  return (
    <div className="toasts">
      {shown.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'error' && <CircleAlert size={14} className="toast-icon" aria-hidden />}
          <span className="toast-msg">{t.msg}</span>
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
      {queued > 0 && (
        <div className="toast-more mono faint">
          {queued} more {queued === 1 ? 'error' : 'errors'}
        </div>
      )}
    </div>
  )
}

// Last line of defense: a render error shows this instead of a blank page.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard crashed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p className="faint">The dashboard hit an unexpected error. Reloading usually fixes it.</p>
        <pre className="mono crash-detail">{error.message || String(error)}</pre>
        <button className="btn" onClick={() => window.location.reload()}>
          <RotateCw size={14} />
          Reload
        </button>
      </div>
    )
  }
}
