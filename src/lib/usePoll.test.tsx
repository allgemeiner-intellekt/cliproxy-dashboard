import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePoll } from './usePoll'

let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
const setHidden = (value: boolean) =>
  act(() => {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  })

afterEach(() => {
  cleanup()
  hidden = false
})

// A task that records each run's signal and never settles on its own.
function recorder() {
  const signals: AbortSignal[] = []
  const task = (signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<void>(() => {})
  }
  return { signals, task }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('usePoll', () => {
  test('runs at once, then on every interval', async () => {
    const { signals, task } = recorder()
    renderHook(() => usePoll(task, 30))
    expect(signals).toHaveLength(1)
    await act(() => wait(150))
    expect(signals.length).toBeGreaterThanOrEqual(3)
  })

  test('a new run aborts the one before it', async () => {
    const { signals, task } = recorder()
    const { result } = renderHook(() => usePoll(task, 10_000))
    act(() => result.current())
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  test('pauses while hidden and runs again as soon as the tab is visible', async () => {
    const { signals, task } = recorder()
    renderHook(() => usePoll(task, 20))
    setHidden(true)
    const before = signals.length
    await act(() => wait(70))
    expect(signals.length).toBe(before)

    setHidden(false)
    expect(signals.length).toBe(before + 1)
  })

  test('refresh() does nothing while hidden', () => {
    const { signals, task } = recorder()
    const { result } = renderHook(() => usePoll(task, 10_000))
    setHidden(true)
    act(() => result.current())
    expect(signals).toHaveLength(1)
  })

  test('a new task (e.g. another range) aborts the old run and starts over', () => {
    const a = recorder()
    const b = recorder()
    const { rerender } = renderHook(({ task }) => usePoll(task, 10_000), { initialProps: { task: a.task } })
    rerender({ task: b.task })
    expect(a.signals.at(-1)?.aborted).toBe(true)
    expect(b.signals).toHaveLength(1)
  })

  test('unmounting aborts the run in flight and stops the timer', async () => {
    const { signals, task } = recorder()
    const { unmount } = renderHook(() => usePoll(task, 20))
    unmount()
    expect(signals.at(-1)?.aborted).toBe(true)
    const count = signals.length
    await wait(60)
    expect(signals.length).toBe(count)
  })
})
