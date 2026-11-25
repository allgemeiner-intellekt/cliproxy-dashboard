import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'cliproxy-theme'
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#0c0c0e',
  light: '#ffffff',
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function writeThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    // Storage may be unavailable in private browsing or sandboxed contexts.
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(THEME_MEDIA_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(pref: ThemePreference, system: ResolvedTheme = getSystemTheme()): ResolvedTheme {
  return pref === 'system' ? system : pref
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved])
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference)
  const [system, setSystem] = useState<ResolvedTheme>(getSystemTheme)

  const resolved = resolveTheme(preference, system)

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    writeThemePreference(next)
  }, [])

  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(THEME_MEDIA_QUERY)
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return
      setPreferenceState(isThemePreference(e.newValue) ? e.newValue : 'system')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return { preference, resolved, setPreference }
}
