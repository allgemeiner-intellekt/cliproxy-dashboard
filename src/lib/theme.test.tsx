import '../test/dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  useTheme,
  writeThemePreference,
} from './theme'

function mockMatchMedia(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    get matches() {
      return matches
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList

  window.matchMedia = () => mql
  return {
    setDark(next: boolean) {
      matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.head.innerHTML = '<meta name="theme-color" content="#0a0a0a" />'
})

afterEach(cleanup)

describe('theme helpers', () => {
  test('defaults to system when storage is empty or invalid', () => {
    expect(readThemePreference()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readThemePreference()).toBe('system')
  })

  test('reads and writes valid preferences', () => {
    writeThemePreference('light')
    expect(readThemePreference()).toBe('light')
    writeThemePreference('dark')
    expect(readThemePreference()).toBe('dark')
  })

  test('resolves explicit and system preferences', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('system', 'light')).toBe('light')
    expect(resolveTheme('system', 'dark')).toBe('dark')
  })

  test('applyTheme sets data-theme and meta theme-color', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.light)

    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark)
  })
})

describe('useTheme', () => {
  test('follows system preference changes and persists manual selection', () => {
    const media = mockMatchMedia(false)

    function Harness() {
      const { preference, resolved, setPreference } = useTheme()
      return (
        <div>
          <span data-testid="state">{`${preference}:${resolved}`}</span>
          <button type="button" onClick={() => setPreference('light')}>
            light
          </button>
        </div>
      )
    }

    const ui = within(render(<Harness />).container)
    expect(ui.getByTestId('state').textContent).toBe('system:light')
    expect(document.documentElement.dataset.theme).toBe('light')

    act(() => media.setDark(true))
    expect(ui.getByTestId('state').textContent).toBe('system:dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.click(ui.getByRole('button', { name: 'light' }))
    expect(ui.getByTestId('state').textContent).toBe('light:light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')

    // System changes should not override an explicit preference.
    act(() => media.setDark(false))
    act(() => media.setDark(true))
    expect(ui.getByTestId('state').textContent).toBe('light:light')
  })
})
