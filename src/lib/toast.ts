// Toast messages: a tiny pub/sub so any module can call toast(), plus the rules
// for which toasts are kept and shown. <Toaster> (components/ui) renders them.
//
// Info toasts go away on their own; errors stay until dismissed, so there is
// time to read them. At most four show at once: errors first, oldest first,
// with any further errors queued behind them and shown as earlier ones are
// dismissed.

export type ToastKind = 'info' | 'error'
export type ToastItem = { id: number; kind: ToastKind; msg: string }

export const INFO_TOAST_MS = 4000
export const MAX_VISIBLE = 4
const MAX_QUEUED_ERRORS = 50

type Listener = (msg: string, kind: ToastKind) => void
const listeners = new Set<Listener>()

export const toast = (msg: string, kind: ToastKind = 'error') => {
  for (const listener of listeners) listener(msg, kind)
}

export function onToast(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The list after adding `item`. The same message and kind again replaces the
// earlier copy instead of piling up. Info toasts are transient, so only the
// newest few are kept; errors are kept (bounded) until dismissed.
export function addToast(items: ToastItem[], item: ToastItem): ToastItem[] {
  const next = [...items.filter((t) => t.msg !== item.msg || t.kind !== item.kind), item]
  const infos = next.filter((t) => t.kind === 'info').slice(0, -MAX_VISIBLE)
  const errors = next.filter((t) => t.kind === 'error').slice(0, -MAX_QUEUED_ERRORS)
  const drop = new Set([...infos, ...errors])
  return next.filter((t) => !drop.has(t))
}

// Which toasts are on screen: the oldest errors, then the newest info toasts in
// the slots that are left. Kept in arrival order.
export function visibleToasts<T extends { kind: ToastKind }>(items: T[], max = MAX_VISIBLE): { shown: T[]; queued: number } {
  const errors = items.filter((t) => t.kind === 'error')
  const keep = new Set<T>(errors.slice(0, max))
  const infos = items.filter((t) => t.kind === 'info')
  for (const t of infos.slice(Math.max(0, infos.length - (max - keep.size)))) keep.add(t)
  return { shown: items.filter((t) => keep.has(t)), queued: Math.max(0, errors.length - max) }
}
