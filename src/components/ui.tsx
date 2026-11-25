import { CircleAlert, RotateCw, X } from 'lucide-react'
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'

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

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group">
      {options.map(([v, label]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// Toasts stack, newest at the bottom. Info toasts go away on their own; errors
// stay until dismissed, so there is time to read them. At most four show at
// once: errors first, oldest first, with any further errors queued behind them
// and shown as earlier ones are dismissed.
type ToastKind = 'info' | 'error'
type ToastItem = { id: number; kind: ToastKind; msg: string }

const INFO_TOAST_MS = 4000
const MAX_VISIBLE = 4
const MAX_QUEUED_ERRORS = 50

let pushToast: (msg: string, kind: ToastKind) => void = () => {}
export const toast = (msg: string, kind: ToastKind = 'error') => pushToast(msg, kind)

// Which toasts are on screen: the oldest errors, then the newest info toasts in
// the slots that are left. Kept in arrival order.
function visibleToasts<T extends { kind: ToastKind }>(items: T[], max = MAX_VISIBLE): { shown: T[]; queued: number } {
  const errors = items.filter((t) => t.kind === 'error')
  const keep = new Set<T>(errors.slice(0, max))
  const infos = items.filter((t) => t.kind === 'info')
  for (const t of infos.slice(Math.max(0, infos.length - (max - keep.size)))) keep.add(t)
  return { shown: items.filter((t) => keep.has(t)), queued: Math.max(0, errors.length - max) }
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    let nextId = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    pushToast = (msg, kind) => {
      const id = ++nextId
      setItems((prev) => {
        // The same message again replaces the earlier copy instead of piling up.
        const next = [...prev.filter((t) => t.msg !== msg || t.kind !== kind), { id, kind, msg }]
        // Info toasts are transient, so only the newest few are kept; errors
        // are kept (bounded) until dismissed.
        const infos = next.filter((t) => t.kind === 'info').slice(0, -MAX_VISIBLE)
        const errors = next.filter((t) => t.kind === 'error').slice(0, -MAX_QUEUED_ERRORS)
        const drop = new Set([...infos, ...errors])
        return next.filter((t) => !drop.has(t))
      })
      if (kind === 'info') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          setItems((prev) => prev.filter((t) => t.id !== id))
        }, INFO_TOAST_MS)
        timers.add(timer)
      }
    }
    return () => {
      pushToast = () => {}
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
