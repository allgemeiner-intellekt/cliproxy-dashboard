import '../test/dom'
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePoll } from './usePoll'

let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
const setHidden = (value: boolean) =>
  act(() => {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  })

// A controlled clock, so interval counts don't depend on how busy the machine is.
beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  cleanup()
  jest.useRealTimers()
  hidden = false
})
const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms))

// A task that records each run's signal and never settles on its own.
function recorder() {
  const signals: AbortSignal[] = []
  const task = (signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<void>(() => {})
  }
  return { signals, task }
}


describe('usePoll', () => {
  test('runs at once, then on every interval', () => {
    const { signals, task } = recorder()
    renderHook(() => usePoll(task, 30))
    expect(signals).toHaveLength(1)
    advance(29)
    expect(signals).toHaveLength(1)
    advance(1)
    expect(signals).toHaveLength(2)
    advance(60)
    expect(signals).toHaveLength(4)
  })

  test('a new run aborts the one before it', () => {
    const { signals, task } = recorder()
    const { result } = renderHook(() => usePoll(task, 10_000))
    act(() => result.current())
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  test('pauses while hidden and runs again as soon as the tab is visible', () => {
    const { signals, task } = recorder()
    renderHook(() => usePoll(task, 20))
    setHidden(true)
    advance(200)
    expect(signals).toHaveLength(1)

    setHidden(false)
    expect(signals).toHaveLength(2)
    // The timer restarts from the visible moment.
    advance(19)
    expect(signals).toHaveLength(2)
    advance(1)
    expect(signals).toHaveLength(3)
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

  test('unmounting aborts the run in flight and stops the timer', () => {
    const { signals, task } = recorder()
    const { unmount } = renderHook(() => usePoll(task, 20))
    unmount()
    expect(signals.at(-1)?.aborted).toBe(true)
    advance(200)
    expect(signals).toHaveLength(1)
  })
})
