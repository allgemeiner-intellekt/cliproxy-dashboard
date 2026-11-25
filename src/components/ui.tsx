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
// stay until dismissed, so there is time to read them.
type ToastKind = 'info' | 'error'
type ToastItem = { id: number; kind: ToastKind; msg: string }

const INFO_TOAST_MS = 4000
const MAX_TOASTS = 4

let pushToast: (msg: string, kind: ToastKind) => void = () => {}
export const toast = (msg: string, kind: ToastKind = 'error') => pushToast(msg, kind)

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
        // Over the cap, drop the oldest info toast first; errors go only when
        // the stack is all errors.
        while (next.length > MAX_TOASTS) {
          const info = next.findIndex((t) => t.kind === 'info')
          next.splice(info >= 0 ? info : 0, 1)
        }
        return next
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

  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'error' && <CircleAlert size={14} className="toast-icon" aria-hidden />}
          <span className="toast-msg">{t.msg}</span>
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
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
