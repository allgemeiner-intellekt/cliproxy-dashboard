import { describe, expect, test } from 'bun:test'
import { bucketLabel, chartKeyTarget, describeBucket, monotonePath, niceScale, weekdayLabel } from './chart'

describe('niceScale', () => {
  test.each([
    [0, 4, { top: 4, step: 1 }],
    [-5, 4, { top: 4, step: 1 }],
    [10, 4, { top: 10, step: 5 }],
    [7, 4, { top: 8, step: 2 }],
    [37_000_000, 4, { top: 40_000_000, step: 10_000_000 }],
    [1.3, 4, { top: 1.5, step: 0.5 }],
  ])('niceScale(%p, %p)', (max, ticks, expected) => {
    const got = niceScale(max, ticks)
    expect(got.step).toBeCloseTo(expected.step)
    expect(got.top).toBeCloseTo(expected.top)
  })

  test('top always covers the max, with about the asked number of steps', () => {
    for (const max of [0.01, 1, 3, 99, 101, 12345, 9.99e9]) {
      const { top, step } = niceScale(max, 4)
      expect(top).toBeGreaterThanOrEqual(max)
      expect(top / step).toBeLessThanOrEqual(8)
      expect(top / step).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('monotonePath', () => {
  test('handles 0, 1 and 2 points', () => {
    expect(monotonePath([])).toBe('')
    expect(monotonePath([[1, 2]])).toBe('M1,2')
    expect(monotonePath([[0, 0], [3, 3]])).toBe('M0,0C1,1 2,2 3,3')
  })

  test('never overshoots: control points stay within each segment', () => {
    const points: [number, number][] = [[0, 10], [1, 0], [2, 10], [3, 10], [4, 0]]
    const d = monotonePath(points)
    const ys = [...d.matchAll(/[ ,C](-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]))
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(10)
    }
  })
})

describe('labels', () => {
  test('day keys format as the date itself, in any time zone', () => {
    expect(bucketLabel('2026-11-24')).toBe('Nov 24')
    expect(bucketLabel('2026-01-01', true)).toBe('Jan 1')
    expect(weekdayLabel('2026-11-24')).toBe('Tue')
  })

  test('hour keys format in local time', () => {
    const key = new Date(2026, 10, 24, 21).getTime()
    expect(bucketLabel(key)).toBe('9 PM')
    expect(bucketLabel(key, true)).toBe('Tue, Nov 24, 9 PM')
  })
})

describe('chart keyboard', () => {
  test('arrows step and clamp, Home/End jump, Escape lets go', () => {
    expect(chartKeyTarget('ArrowLeft', 3, 10)).toBe(2)
    expect(chartKeyTarget('ArrowLeft', 0, 10)).toBe(0)
    expect(chartKeyTarget('ArrowRight', 9, 10)).toBe(9)
    expect(chartKeyTarget('ArrowUp', 4, 10)).toBe(5)
    expect(chartKeyTarget('Home', 4, 10)).toBe(0)
    expect(chartKeyTarget('End', 4, 10)).toBe(9)
    expect(chartKeyTarget('Escape', 4, 10)).toBeNull()
    expect(chartKeyTarget('Tab', 4, 10)).toBeUndefined()
  })

  test('describeBucket reads every series and the total', () => {
    const lines = [
      { label: 'OpenAI', values: [1, 2] },
      { label: 'Anthropic', values: [3, 4] },
    ]
    expect(describeBucket('Nov 24', lines, 1, (v) => `$${v}`)).toBe('Nov 24: OpenAI $2, Anthropic $4. Total $6.')
  })
})
