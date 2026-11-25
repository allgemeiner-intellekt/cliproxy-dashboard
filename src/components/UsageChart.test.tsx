import '../test/dom'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { summary } from '../test/fixtures'
import { UsageChart } from './UsageChart'

// happy-dom doesn't lay anything out: report a 664px-wide plot (600px of it
// after the 64px axis), so the SVG and pointer handling render.
const RealResizeObserver = globalThis.ResizeObserver
beforeEach(() => {
  globalThis.ResizeObserver = class {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }
    observe() {
      this.cb([{ contentRect: { width: 664 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = RealResizeObserver
})

// Two daily buckets: Nov 23 ($1.00) and Nov 24 ($2.00).
const setup = () => {
  const view = render(<UsageChart summary={summary('30d', 3_000_000)} metric="cost" by="provider" />)
  const ui = within(view.container)
  const slider = ui.getByRole('slider', { name: 'Cost by day, by provider' })
  const svg = view.container.querySelector('svg')!
  // x = 64 + i * 600 for buckets 0 and 1; the plot's left edge is 0 here.
  const pointAt = (i: number) => act(() => fireEvent.pointerMove(svg, { clientX: 64 + i * 600 }))
  const tooltip = () => view.container.querySelector('.tooltip-title')?.textContent ?? null
  return { slider, svg, pointAt, tooltip }
}

test('the chart is a slider whose value text reads the bucket', () => {
  const { slider } = setup()
  expect(slider.getAttribute('aria-valuemax')).toBe('2')
  expect(slider.getAttribute('aria-valuenow')).toBe('2')
  expect(slider.getAttribute('aria-valuetext')).toBe('Nov 24: Anthropic $2.00. Total $2.00.')
})

test('arrow keys, Home and End move the keyboard pick and the tooltip', () => {
  const { slider, tooltip } = setup()
  act(() => slider.focus())
  expect(tooltip()).toBe('Nov 24')
  fireEvent.keyDown(slider, { key: 'ArrowLeft' })
  expect(slider.getAttribute('aria-valuetext')).toBe('Nov 23: Anthropic $1.00. Total $1.00.')
  expect(tooltip()).toBe('Nov 23')
  fireEvent.keyDown(slider, { key: 'End' })
  expect(slider.getAttribute('aria-valuenow')).toBe('2')
  fireEvent.keyDown(slider, { key: 'Home' })
  expect(slider.getAttribute('aria-valuenow')).toBe('1')
})

test('focusing while the pointer is over the chart still picks a bucket', () => {
  const { slider, pointAt, tooltip } = setup()
  pointAt(0)
  act(() => slider.focus())
  expect(slider.getAttribute('aria-valuetext')).toBe('Nov 24: Anthropic $2.00. Total $2.00.')
  // The pointer still owns the tooltip while it's over the chart.
  expect(tooltip()).toBe('Nov 23')
})

test('pointer moves leave the keyboard pick alone', () => {
  const { slider, svg, pointAt, tooltip } = setup()
  act(() => slider.focus())
  fireEvent.keyDown(slider, { key: 'Home' })
  pointAt(1)
  expect(tooltip()).toBe('Nov 24')
  expect(slider.getAttribute('aria-valuetext')).toStartWith('Nov 23')

  // Leaving the chart shows the keyboard pick again; blurring hides it.
  act(() => fireEvent.pointerLeave(svg))
  expect(tooltip()).toBe('Nov 23')
  act(() => slider.blur())
  expect(tooltip()).toBeNull()
})

test('an empty chart is a labelled image, not a slider', () => {
  const view = render(<UsageChart summary={{ ...summary(), series: [] }} metric="cost" by="provider" />)
  expect(within(view.container).queryByRole('slider')).toBeNull()
  expect(within(view.container).getByRole('img', { name: 'Cost by day, by provider: no data' })).toBeTruthy()
})
