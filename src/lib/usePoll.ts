import { useCallback, useEffect, useRef } from 'react'

// Runs `task` now and every `everyMs` while the tab is visible. Hidden tabs stop
// polling; coming back runs the task at once and restarts the timer.
//
// Each run gets its own AbortSignal. Starting a run aborts the one before it, and
// so does a change of `task` (wrap it in useCallback) or unmounting, so a slow
// response from an earlier run can never land after a newer one.
//
// Returns `refresh`, which runs the task now (e.g. after an edit or a retry),
// or on return if the tab is hidden.
export function usePoll(task: (signal: AbortSignal) => Promise<void>, everyMs: number): () => void {
  const runRef = useRef<() => void>(() => {})

  useEffect(() => {
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setInterval> | undefined

    const run = () => {
      // Hidden tabs don't fetch, even on refresh(); coming back runs it anyway.
      if (document.hidden) return
      controller?.abort()
      const current = new AbortController()
      controller = current
      task(current.signal).catch(() => {}) // tasks handle their own errors
    }
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      run()
      timer = setInterval(run, everyMs)
    }
    const onVisibility = () => (document.hidden ? stop() : start())

    runRef.current = run
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
      controller?.abort()
      runRef.current = () => {}
    }
  }, [task, everyMs])

  return useCallback(() => runRef.current(), [])
}

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
