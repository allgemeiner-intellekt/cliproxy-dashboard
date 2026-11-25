// Browser-local display preferences shared across UsagePage, Header health
// polling, and the Settings modal.

import { useEffect, useState } from 'react'

export type PollInterval = '15' | '30' | '60' | 'off'

export type DisplayPrefs = {
  pollInterval: PollInterval
  timeZone: string // 'auto' or an IANA time zone name
}

const STORAGE_KEY = 'cpa:display-prefs'
const DEFAULT_PREFS: DisplayPrefs = { pollInterval: '30', timeZone: 'auto' }
const VALID_INTERVALS = new Set<PollInterval>(['15', '30', '60', 'off'])

const listeners = new Set<(next: DisplayPrefs) => void>()

export function pollIntervalMs(interval: PollInterval): number {
  if (interval === '15') return 15e3
  if (interval === '30') return 30e3
  if (interval === '60') return 60e3
  return 0
}

export function resolveTimeZone(prefTz: string): string {
  if (!prefTz || prefTz === 'auto') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  return prefTz
}

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<DisplayPrefs>
    const pollInterval = VALID_INTERVALS.has(parsed.pollInterval as PollInterval)
      ? (parsed.pollInterval as PollInterval)
      : DEFAULT_PREFS.pollInterval
    const timeZone = typeof parsed.timeZone === 'string' && parsed.timeZone.trim() ? parsed.timeZone.trim() : 'auto'
    return { pollInterval, timeZone }
  } catch {
    return DEFAULT_PREFS
  }
}

export function saveDisplayPrefs(patch: Partial<DisplayPrefs>): DisplayPrefs {
  const next = { ...loadDisplayPrefs(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore storage quota / private-mode failures.
  }
  for (const listener of listeners) listener(next)
  return next
}

export function useDisplayPrefs() {
  const [prefs, setPrefs] = useState<DisplayPrefs>(loadDisplayPrefs)

  useEffect(() => {
    const onUpdate = (next: DisplayPrefs) => setPrefs(next)
    listeners.add(onUpdate)
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPrefs(loadDisplayPrefs())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(onUpdate)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return [prefs, saveDisplayPrefs] as const
}
