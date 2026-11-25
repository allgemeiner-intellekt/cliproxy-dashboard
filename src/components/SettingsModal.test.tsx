import '../test/dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { loadDisplayPrefs } from '../lib/prefs'
import type { SystemInfo } from '../lib/usage'
import { SettingsModal } from './SettingsModal'

const mockSystem: SystemInfo = {
  collector: {
    target: 'http://127.0.0.1:8317',
    keyConfigured: true,
    connected: true,
    authFailed: false,
    since: Date.now() - 3600e3,
    downSince: null,
    lastRecordAt: Date.now() - 10e3,
    stored: 120,
    lastError: null,
  },
  pricing: {
    loadedAt: Date.now() - 1800e3,
    cachePath: 'data/litellm-prices.json',
    totalCatalogModels: 2400,
    usedModels: [
      {
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        pricedAs: 'anthropic/claude-sonnet-4-5',
        matchKind: 'exact',
        requests: 90,
        unpricedRequests: 0,
        rates: {
          input: 3_000_000,
          output: 15_000_000,
          cacheRead: 300_000,
          cacheWrite: 3_750_000,
          tiers: [
            {
              aboveTokens: 200_000,
              rates: {
                input: 6_000_000,
                output: 22_500_000,
                cacheRead: 600_000,
                cacheWrite: 7_500_000,
              },
            },
          ],
        },
      },
      {
        model: 'mystery-preview',
        provider: 'openai',
        pricedAs: null,
        matchKind: 'unpriced',
        requests: 5,
        unpricedRequests: 5,
        rates: null,
      },
    ],
  },
  storage: {
    dbPath: 'data/usage.db',
    dbSizeBytes: 2 * 1024 * 1024,
    walSizeBytes: 256 * 1024,
    totalRequests: 95,
    unpricedRequests: 5,
    earliestAt: Date.now() - 7 * 86400e3,
    latestAt: Date.now() - 10e3,
  },
  runtime: {
    listenAddress: '127.0.0.1:5174',
    allowedHosts: ['localhost', '127.0.0.1', '*.ts.net'],
    tailnet: { syncedAt: null, error: null },
  },
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('SettingsModal', () => {
  test('loads system info, switches panes, expands long-context tiers, and saves display preferences', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/api/system') {
        return new Response(JSON.stringify(mockSystem), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/api/collector/reconnect') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/api/pricing/refresh') {
        return new Response(
          JSON.stringify({ ok: true, downloaded: true, repriced: true, error: null, loadedAt: Date.now(), totalCatalogModels: 2401 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    let closed = 0
    let changed = 0
    const { container } = render(
      <SettingsModal open initialPane="connection" onClose={() => (closed += 1)} onDataChanged={() => (changed += 1)} />,
    )
    const ui = within(container)

    await waitFor(() => expect(ui.getByText('http://127.0.0.1:8317')).toBeTruthy())

    // Trigger reconnect
    fireEvent.click(ui.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(calls).toContain('POST /api/collector/reconnect'))
    expect(changed).toBe(1)

    // Switch to Model Pricing pane
    fireEvent.click(ui.getByRole('button', { name: /Model Pricing/ }))
    expect(ui.getByText('claude-sonnet-4-5')).toBeTruthy()
    expect(ui.getByText('mystery-preview')).toBeTruthy()

    // Expand long-context tier
    fireEvent.click(ui.getByRole('button', { name: /Show long-context tiers for claude-sonnet-4-5/ }))
    expect(ui.getByText('Prompt > 200k tokens')).toBeTruthy()

    // Filter unpriced only
    fireEvent.click(ui.getByRole('button', { name: 'Unpriced (1)' }))
    expect(ui.queryByText('claude-sonnet-4-5')).toBeNull()
    expect(ui.getByText('mystery-preview')).toBeTruthy()

    // Trigger price refresh
    fireEvent.click(ui.getByRole('button', { name: 'Refresh & Reprice' }))
    await waitFor(() => expect(calls).toContain('POST /api/pricing/refresh'))
    expect(changed).toBe(2)

    // Switch to Preferences and change poll interval & timezone
    fireEvent.click(ui.getByRole('button', { name: 'Preferences' }))
    fireEvent.click(ui.getByRole('button', { name: 'Off' }))
    fireEvent.change(ui.getByLabelText('Reporting time zone'), { target: { value: 'UTC' } })
    expect(loadDisplayPrefs()).toEqual({ pollInterval: 'off', timeZone: 'UTC' })

    // Switch to Storage
    fireEvent.click(ui.getByRole('button', { name: 'Storage' }))
    expect(ui.getByText('data/usage.db')).toBeTruthy()

    // Escape closes modal
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toBe(1)
  })

  test('ignores out-of-order system snapshots and labels dropped catalog models accurately', async () => {
    let resolveSecond!: (res: Response) => void
    let sysCalls = 0
    const droppedModelSystem: SystemInfo = {
      ...mockSystem,
      collector: { ...mockSystem.collector, stored: 999 },
      pricing: {
        ...mockSystem.pricing,
        usedModels: [
          {
            model: 'legacy-priced-model',
            provider: 'openai',
            pricedAs: null,
            matchKind: 'unpriced',
            requests: 42,
            unpricedRequests: 0,
            rates: null,
          },
        ],
      },
    }

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/system') {
        sysCalls += 1
        if (sysCalls === 1) {
          return new Response(JSON.stringify(mockSystem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (sysCalls === 2) {
          // Slow snapshot triggered by Reconnect; resolves AFTER call #3.
          return new Promise<Response>((resolve) => {
            resolveSecond = resolve
          })
        }
        return new Response(JSON.stringify(droppedModelSystem), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/collector/reconnect') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/api/pricing/refresh') {
        return new Response(
          JSON.stringify({ ok: true, downloaded: true, repriced: true, error: null, loadedAt: Date.now(), totalCatalogModels: 2401 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const { container } = render(
      <SettingsModal open initialPane="connection" onClose={() => {}} onDataChanged={() => {}} />,
    )
    const ui = within(container)

    await waitFor(() => expect(ui.getByText('120 requests')).toBeTruthy())

    // Start slow snapshot #2 via Reconnect, then switch to Pricing and trigger faster snapshot #3.
    fireEvent.click(ui.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(sysCalls).toBe(2))

    fireEvent.click(ui.getByRole('button', { name: /Model Pricing/ }))
    fireEvent.click(ui.getByRole('button', { name: 'Refresh & Reprice' }))
    await waitFor(() => expect(sysCalls).toBe(3))
    await waitFor(() => expect(ui.getByText('No catalog rate')).toBeTruthy())

    // Late resolution of snapshot #2 (stale 120 requests) must not overwrite snapshot #3 (999 requests).
    await act(async () => {
      resolveSecond(
        new Response(JSON.stringify(mockSystem), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      await Promise.resolve()
    })

    expect(ui.getByText('No catalog rate')).toBeTruthy()
    expect(ui.queryByText(/Unpriced · 42/)).toBeNull()
    expect(ui.getByRole('button', { name: 'Unpriced (0)' })).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: 'Connection' }))
    expect(ui.getByText('999 requests')).toBeTruthy()
  })

  test('moves initial focus into dialog, traps Tab focus, and restores focus to opener on Escape', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockSystem), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    let open = true
    const { container, rerender } = render(
      <SettingsModal open={open} initialPane="connection" onClose={() => (open = false)} onDataChanged={() => {}} />,
    )
    const dialog = within(container).getByRole('dialog', { name: 'Settings' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Focus last focusable button and press Tab -> wraps to first inside dialog.
    const buttons = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')]
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // Shift+Tab from first -> wraps to last inside dialog.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Escape closes and unmount restores focus to opener.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(open).toBe(false)
    rerender(<SettingsModal open={false} initialPane="connection" onClose={() => {}} onDataChanged={() => {}} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
