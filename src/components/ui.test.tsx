import '../test/dom'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { toast } from '../lib/toast'
import { ErrorBoundary, Segmented, Toaster } from './ui'

afterEach(cleanup)

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('providers is null')
  }

  test('shows the error and a Reload button instead of a blank page', () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    const ui = within(
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      ).container,
    )
    quiet.mockRestore()
    expect(ui.getByRole('alert').textContent).toContain('providers is null')
    expect(ui.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  test('renders children when nothing throws', () => {
    const ui = within(render(<ErrorBoundary>fine</ErrorBoundary>).container)
    expect(ui.getByText('fine')).toBeTruthy()
  })
})

describe('Toaster', () => {
  test('errors stay until dismissed; extra ones queue behind the first four', () => {
    const ui = within(render(<Toaster />).container)
    act(() => {
      for (const m of ['e1', 'e2', 'e3', 'e4', 'e5']) toast(m)
    })
    expect(ui.getAllByRole('alert').map((a) => a.textContent)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(ui.getByText('1 more error')).toBeTruthy()

    fireEvent.click(ui.getAllByRole('button', { name: 'Dismiss' })[0])
    expect(ui.getAllByRole('alert').map((a) => a.textContent)).toEqual(['e2', 'e3', 'e4', 'e5'])
    expect(ui.queryByText(/more error/)).toBeNull()
  })

  test('info toasts are status messages', () => {
    const ui = within(render(<Toaster />).container)
    act(() => toast('Renamed', 'info'))
    expect(ui.getByRole('status').textContent).toBe('Renamed')
  })
})

test('Segmented is a labelled group of pressed/unpressed buttons', () => {
  let picked = ''
  const ui = within(
    render(
      <Segmented
        label="Metric"
        value="cost"
        onChange={(v) => (picked = v)}
        options={[
          ['cost', 'Cost'],
          ['tokens', 'Tokens'],
        ]}
      />,
    ).container,
  )
  const group = within(ui.getByRole('group', { name: 'Metric' }))
  expect(group.getByRole('button', { name: 'Cost' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(group.getByRole('button', { name: 'Tokens' }))
  expect(picked).toBe('tokens')
})
