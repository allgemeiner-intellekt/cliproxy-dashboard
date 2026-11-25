import '../test/dom'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { json, summary } from '../test/fixtures'
import { UsagePage } from './UsagePage'

// /api/usage requests wait here until the test answers them.
type Pending = { range: string; signal?: AbortSignal; answered?: boolean; answer: (res: Response) => void }
let pending: Pending[] = []
// Ranges whose requests act like a server that answers anyway after the
// client gave up, so the page's own stale-response guard is what's tested.
let ignoreAbort = new Set<string>()
const realFetch = globalThis.fetch

beforeEach(() => {
  localStorage.clear()
  pending = []
  ignoreAbort = new Set()
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const range = new URL(String(url), 'http://localhost').searchParams.get('range') ?? ''
      if (!ignoreAbort.has(range)) init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      pending.push({ range, signal: init?.signal ?? undefined, answer: resolve })
    })) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const answer = async (range: string, res: Response) => {
  const req = pending.find((p) => p.range === range && !p.answered && !p.signal?.aborted)
  if (!req) throw new Error(`no open request for ${range}`)
  req.answered = true
  await act(async () => req.answer(res))
}

const setup = () => {
  const view = render(<UsagePage />)
  const ui = within(view.container)
  const rangeButton = (label: string) => within(ui.getByRole('group', { name: 'Time range' })).getByRole('button', { name: label })
  return { ...view, ui, rangeButton }
}

describe('UsagePage', () => {
  test('shows a skeleton until the first load, then the data', async () => {
    const { ui } = setup()
    expect(ui.getByText('Loading usage')).toBeTruthy()
    await answer('30d', json(summary('30d', 12_340_000)))
    expect(ui.getAllByText('$12.34').length).toBeGreaterThan(0)
    expect(ui.queryByText('Loading usage')).toBeNull()
  })

  test('U5: a slow response for an earlier range never replaces the newer one', async () => {
    ignoreAbort.add('all')
    const { ui, rangeButton } = setup()
    await answer('30d', json(summary('30d', 1_000_000)))

    fireEvent.click(rangeButton('All time'))
    fireEvent.click(rangeButton('24 hours'))
    await answer('24h', json(summary('24h', 2_000_000)))
    expect(ui.getAllByText('$2.00').length).toBeGreaterThan(0)

    // The earlier request was aborted, but its response still arrives, last.
    const late = pending.find((p) => p.range === 'all')!
    expect(late.signal?.aborted).toBe(true)
    await act(async () => late.answer(json(summary('all', 9_000_000))))

    expect(ui.getAllByText('$2.00').length).toBeGreaterThan(0)
    expect(ui.queryByText('$9.00')).toBeNull()
    expect(ui.getByText('Hourly cost')).toBeTruthy()
  })

  test('U6: old numbers are dimmed while another range loads', async () => {
    const { container, rangeButton } = setup()
    await answer('30d', json(summary('30d')))
    fireEvent.click(rangeButton('7 days'))
    expect(container.querySelector('.ubody')?.className).toContain('is-stale')
    await answer('7d', json(summary('7d')))
    expect(container.querySelector('.ubody')?.className).not.toContain('is-stale')
  })

  test('a failed load shows the error with Retry, which recovers', async () => {
    const { ui } = setup()
    await answer('30d', json({ error: 'database is locked' }, 500))
    expect(ui.getByRole('alert').textContent).toContain('database is locked')

    fireEvent.click(ui.getByRole('button', { name: 'Retry' }))
    await answer('30d', json(summary('30d', 5_000_000)))
    expect(ui.queryByRole('alert')).toBeNull()
    expect(ui.getAllByText('$5.00').length).toBeGreaterThan(0)
  })

  test('a malformed response is a load error, not a crash', async () => {
    const { ui } = setup()
    await answer('30d', json({ ...summary(), providers: [null] }))
    expect(ui.getByRole('alert').textContent).toContain('Unexpected response')
  })

  test('U14: in Tokens mode the Day breakdown totals tokens and shows cost beside it', async () => {
    const { ui } = setup()
    await answer('30d', json(summary('30d', 3_000_000, 1_500_000)))
    fireEvent.click(within(ui.getByRole('group', { name: 'Breakdown' })).getByRole('button', { name: 'Day' }))

    const table = () => ui.getByRole('table')
    const headers = () => within(table()).getAllByRole('columnheader').map((h) => h.textContent)
    // Newest day first: 2/3 of the totals.
    const firstRow = () => within(within(table()).getAllByRole('row')[1]).getAllByRole('cell').map((c) => c.textContent)

    expect(headers().slice(-2)).toEqual(['Total', 'Tokens'])
    expect(firstRow().slice(-2)).toEqual(['$2.00', '1M'])

    fireEvent.click(within(ui.getByRole('group', { name: 'Metric' })).getByRole('button', { name: 'Tokens' }))
    expect(headers().slice(-2)).toEqual(['Total', 'Cost'])
    expect(firstRow().slice(-2)).toEqual(['1M', '$2.00'])
  })

  test('remembers the chosen range', async () => {
    const { rangeButton, unmount } = setup()
    fireEvent.click(rangeButton('90 days'))
    unmount()
    const again = setup()
    expect(again.rangeButton('90 days').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(pending.some((p) => p.range === '90d' && !p.signal?.aborted)).toBe(true))
  })
})
