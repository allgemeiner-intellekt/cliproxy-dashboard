import '../test/dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { THEME_STORAGE_KEY } from '../lib/theme'
import { ThemeMenu } from './ThemeMenu'

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.head.innerHTML = '<meta name="theme-color" content="#0a0a0a" />'
  window.matchMedia = () =>
    ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
})

afterEach(cleanup)

describe('ThemeMenu', () => {
  test('opens menu, selects theme, persists it, and closes', () => {
    const ui = within(render(<ThemeMenu />).container)
    const trigger = ui.getByRole('button', { name: 'Theme: System' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(ui.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = within(ui.getByRole('menu', { name: 'Theme' }))
    expect(menu.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(menu.getByRole('menuitemradio', { name: 'Light' }))
    expect(ui.queryByRole('menu')).toBeNull()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(ui.getByRole('button', { name: 'Theme: Light' })).toBeTruthy()
  })

  test('closes on Escape and outside pointerdown', () => {
    const ui = within(render(<ThemeMenu />).container)
    const trigger = ui.getByRole('button', { name: 'Theme: System' })

    fireEvent.click(trigger)
    expect(ui.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(ui.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)
    expect(ui.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(ui.queryByRole('menu')).toBeNull()
  })

  test('moves focus to the active option on open and supports arrow-key navigation', () => {
    const ui = within(render(<ThemeMenu />).container)
    const trigger = ui.getByRole('button', { name: 'Theme: System' })

    fireEvent.click(trigger)
    const menu = ui.getByRole('menu', { name: 'Theme' })
    const light = within(menu).getByRole('menuitemradio', { name: 'Light' })
    const dark = within(menu).getByRole('menuitemradio', { name: 'Dark' })
    const system = within(menu).getByRole('menuitemradio', { name: 'System' })

    expect(document.activeElement).toBe(system)

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(light)

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(dark)

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(light)
  })
})
