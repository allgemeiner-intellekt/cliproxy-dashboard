import { describe, expect, test } from 'bun:test'
import { addToast, MAX_VISIBLE, onToast, toast, visibleToasts, type ToastItem } from './toast'

let id = 0
const add = (items: ToastItem[], msg: string, kind: ToastItem['kind'] = 'error') => addToast(items, { id: ++id, kind, msg })
const msgs = (items: { msg: string }[]) => items.map((t) => t.msg)

describe('addToast', () => {
  test('the same message and kind replaces the earlier copy', () => {
    let items = add([], 'a')
    items = add(items, 'b')
    items = add(items, 'a')
    expect(msgs(items)).toEqual(['b', 'a'])
  })

  test('an info toast does not replace an error with the same text', () => {
    const items = add(add([], 'same'), 'same', 'info')
    expect(items.map((t) => t.kind)).toEqual(['error', 'info'])
  })

  test('keeps only the newest info toasts but every error', () => {
    let items: ToastItem[] = []
    for (let i = 0; i < 10; i++) items = add(items, `e${i}`)
    for (let i = 0; i < 10; i++) items = add(items, `i${i}`, 'info')
    expect(items.filter((t) => t.kind === 'error')).toHaveLength(10)
    expect(msgs(items.filter((t) => t.kind === 'info'))).toEqual(['i6', 'i7', 'i8', 'i9'])
  })
})

describe('visibleToasts', () => {
  test('shows the oldest errors first and counts the queued rest', () => {
    let items: ToastItem[] = []
    for (const m of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) items = add(items, m)
    const { shown, queued } = visibleToasts(items)
    expect(msgs(shown)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(queued).toBe(2)
  })

  test('fills leftover slots with the newest info toasts, in arrival order', () => {
    let items: ToastItem[] = []
    items = add(items, 'i1', 'info')
    items = add(items, 'e1')
    items = add(items, 'i2', 'info')
    items = add(items, 'i3', 'info')
    items = add(items, 'i4', 'info')
    const { shown, queued } = visibleToasts(items)
    expect(shown).toHaveLength(MAX_VISIBLE)
    expect(msgs(shown)).toEqual(['e1', 'i2', 'i3', 'i4'])
    expect(queued).toBe(0)
  })
})

test('toast() reaches every subscriber until it unsubscribes', () => {
  const got: string[] = []
  const off = onToast((msg, kind) => got.push(`${kind}:${msg}`))
  toast('oops')
  toast('saved', 'info')
  off()
  toast('ignored')
  expect(got).toEqual(['error:oops', 'info:saved'])
})
