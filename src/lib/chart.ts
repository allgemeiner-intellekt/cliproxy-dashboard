// Chart math and bucket labels, kept apart from the chart component so they can
// be tested on their own.

export type Point = [x: number, y: number]

// Step of 1, 2 or 5 × 10ⁿ giving about `ticks` intervals up to `max`.
export function niceScale(max: number, ticks: number) {
  if (max <= 0) return { top: ticks, step: 1 }
  const raw = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!
  return { top: Math.ceil(max / step) * step, step }
}

// Monotone cubic interpolation (Fritsch–Carlson) as an SVG path.
export function monotonePath(points: Point[]): string {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${points[0][0]},${points[0][1]}`
  const dx = points.slice(1).map((p, i) => p[0] - points[i][0])
  const slope = points.slice(1).map((p, i) => (p[1] - points[i][1]) / dx[i])
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]
    if (i === n - 1) return slope[n - 2]
    // Flat at local extrema, so the curve never overshoots.
    if (slope[i - 1] * slope[i] <= 0) return 0
    return (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i])
  })
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const h = dx[i] / 3
    d += `C${x0 + h},${y0 + h * tangent[i]} ${x1 - h},${y1 - h * tangent[i + 1]} ${x1},${y1}`
  }
  return d
}

// Day keys are already local dates ("YYYY-MM-DD"), so format them as-is (UTC);
// hour keys are instants, shown in local time.
const dayKeyFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric' })
const hourLongFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })

export function bucketLabel(key: number | string, long = false) {
  if (typeof key === 'string') return dayKeyFmt.format(new Date(`${key}T00:00:00Z`))
  return (long ? hourLongFmt : hourFmt).format(key)
}

// "Mon" for a local day key ("YYYY-MM-DD").
export const weekdayLabel = (day: string) => weekdayFmt.format(new Date(`${day}T00:00:00Z`))

// The bucket a key moves the chart's keyboard cursor to: undefined for keys the
// chart doesn't handle, null to let go (Escape).
export function chartKeyTarget(key: string, at: number, count: number): number | null | undefined {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, at - 1)
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(count - 1, at + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'Escape':
      return null
    default:
      return undefined
  }
}

// What a screen reader hears for one bucket: "Tue, Nov 24, 9 PM: OpenAI $1.20,
// Anthropic $3.00. Total $4.20."
export function describeBucket(
  label: string,
  lines: { label: string; values: number[] }[],
  index: number,
  format: (v: number) => string,
): string {
  const parts = lines.map((l) => `${l.label} ${format(l.values[index] ?? 0)}`)
  const total = lines.reduce((n, l) => n + (l.values[index] ?? 0), 0)
  return `${label}: ${parts.join(', ')}. Total ${format(total)}.`
}
