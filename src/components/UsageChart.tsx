// Cost (or tokens) over time, one overlapping area per provider, as in T3 Code's
// usage view: smooth monotone curves that never overshoot the data, larger
// series painted first, a shared y-scale topped by the largest single value.
// Fills use the dot-matrix pattern; strokes stay solid.

import { useEffect, useRef, useState } from 'react'
import { bucketLabel, chartKeyTarget, describeBucket, monotonePath, niceScale, weekdayLabel } from '../lib/chart'
import { bucketDay, byProviderOrder, formatTokens, formatUsd, providerColor, providerLabel, type UsageSummary } from '../lib/usage'

const HEIGHT = 224
const AXIS_W = 64 // y-axis label column
const PAD_TOP = 8
const PAD_BOTTOM = 8 // room for the "0" label below the baseline

type Metric = 'cost' | 'tokens'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

// Machine colors (CSS --series-*). Past four machines, the smallest fold into "Other".
const MACHINE_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']
const OTHER_COLOR = 'var(--fg-3)'

type Line = { id: string; label: string; color: string; values: number[] }
export type ChartGroup = 'provider' | 'machine'

function linesFor(summary: UsageSummary, by: ChartGroup, valueOf: (p?: { costMicros: number; tokens: number }) => number): Line[] {
  if (by === 'provider') {
    return summary.providers
      .map((t) => t.provider)
      .sort(byProviderOrder)
      .map((provider) => ({ id: provider, label: providerLabel(provider), color: providerColor(provider), values: summary.series.map((b) => valueOf(b.providers[provider])) }))
  }

  const all = summary.byMachine.map((m) => m.name) // biggest first
  const fits = all.length <= MACHINE_COLORS.length
  const shown = fits ? all : all.slice(0, MACHINE_COLORS.length - 1)
  const others = all.filter((name) => !shown.includes(name))
  // Colors go by name order, so a machine keeps its color when rankings shift.
  const byName = [...shown].sort()
  const colorOf = (name: string) => MACHINE_COLORS[byName.indexOf(name)]

  const lines: Line[] = shown.map((name) => ({
    id: name,
    label: name,
    color: colorOf(name),
    values: summary.series.map((b) => valueOf(b.machines[name])),
  }))
  if (others.length) {
    lines.push({
      id: 'other',
      label: `Other (${others.length})`,
      color: OTHER_COLOR,
      values: summary.series.map((b) => others.reduce((n, name) => n + valueOf(b.machines[name]), 0)),
    })
  }
  return lines
}

// Index of each local day's first bucket, for day dividers and labels.
function dayStarts(summary: UsageSummary) {
  const dayOf = bucketDay(summary)
  return summary.series.flatMap((b, index) => {
    const day = dayOf(b.key)
    return index === 0 || day !== dayOf(summary.series[index - 1].key) ? [{ index, day }] : []
  })
}

export function UsageChart({ summary, metric, by }: { summary: UsageSummary; metric: Metric; by: ChartGroup }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  // The bucket under the pointer, and the one picked with the keyboard while
  // the chart has focus. They're separate so neither one moves the other.
  const [pointer, setPointer] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(null)

  const valueOf = (p?: { costMicros: number; tokens: number }) => (p ? (metric === 'cost' ? p.costMicros : p.tokens) : 0)
  const format = (v: number) => (metric === 'cost' ? formatUsd(v) : formatTokens(v))

  const lines = linesFor(summary, by, valueOf)
  const peak = Math.max(0, ...lines.flatMap((l) => l.values))
  const { top, step } = niceScale(peak, 4)

  const plotW = Math.max(width - AXIS_W, 0)
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const count = summary.series.length
  const x = (i: number) => AXIS_W + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2)
  const y = (v: number) => PAD_TOP + plotH - (v / top) * plotH

  // Larger series first, so smaller ones stay visible on top.
  const sum = (l: Line) => l.values.reduce((n, v) => n + v, 0)
  const painted = [...lines].sort((a, b) => sum(b) - sum(a))

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const left = e.clientX - e.currentTarget.getBoundingClientRect().left - AXIS_W
    const i = Math.round((left / plotW) * (count - 1))
    setPointer(i >= 0 && i < count ? i : null)
  }

  // For the keyboard the plot is a slider over the buckets: arrow keys step,
  // Home and End jump to either end, and the value text reads the bucket out.
  // (A slider, not a plain group, so screen readers in browse mode pass the
  // arrow keys through.) The range can shrink under focus, hence the clamp.
  const selected = count ? Math.min(picked ?? count - 1, count - 1) : null
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (selected === null) return
    const next = chartKeyTarget(e.key, selected, count)
    if (next === undefined) return
    e.preventDefault()
    setPicked(next)
  }

  const chartLabel = `${metric === 'cost' ? 'Cost' : 'Tokens'} by ${summary.bucket === 'hour' ? 'hour' : 'day'}, by ${by}`

  const days = summary.range === '7d' ? dayStarts(summary) : []
  // First, middle and last; fewer when there are only one or two buckets.
  const labels = [...new Set(count ? [0, Math.floor((count - 1) / 2), count - 1] : [])]
  // The tooltip follows the pointer, else the keyboard pick while focused.
  const hover = pointer ?? (picked === null ? null : selected)
  const hovered = hover === null ? null : summary.series[hover]

  return (
    <div className="uchart">
      {/* The provider view's legend is the per-provider list beside the chart. */}
      {by === 'machine' && (
        <div className="uchart-legend">
          {lines.map((l) => (
            <span key={l.id} className="uchart-legend-item">
              <span className="tooltip-key" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div
        className="uchart-plot"
        ref={ref}
        {...(selected === null
          ? { role: 'img', 'aria-label': `${chartLabel}: no data` }
          : {
              tabIndex: 0,
              role: 'slider',
              'aria-label': chartLabel,
              'aria-orientation': 'horizontal' as const,
              'aria-valuemin': 1,
              'aria-valuemax': count,
              'aria-valuenow': selected + 1,
              'aria-valuetext': describeBucket(bucketLabel(summary.series[selected].key, true), lines, selected, format),
            })}
        onKeyDown={onKeyDown}
        onFocus={() => setPicked(selected)}
        onBlur={() => setPicked(null)}
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} onPointerMove={onMove} onPointerLeave={() => setPointer(null)} aria-hidden>
            <defs>
              {lines.map((l, i) => (
                <pattern key={l.id} id={`dots-${by}-${i}`} width="3" height="3" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="0.45" fill={l.color} opacity="0.55" />
                </pattern>
              ))}
            </defs>

            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className="grid" x1={AXIS_W} x2={width} y1={y(v)} y2={y(v)} />
                <text className="tick" x={AXIS_W - 10} y={y(v)} dy="0.32em" textAnchor="end">
                  {v === 0 ? '0' : format(v)}
                </text>
              </g>
            ))}

            {painted.map((l) => (
              <path
                key={`fill-${l.id}`}
                d={`${monotonePath(l.values.map((v, i) => [x(i), y(v)]))}L${x(count - 1)},${y(0)}L${x(0)},${y(0)}Z`}
                fill={`url(#dots-${by}-${lines.indexOf(l)})`}
              />
            ))}
            {painted.map((l) => (
              <path
                key={`line-${l.id}`}
                d={monotonePath(l.values.map((v, i) => [x(i), y(v)]))}
                fill="none"
                stroke={l.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            ))}

            {days.slice(1).map((d) => (
              <line key={d.index} className="grid" x1={x(d.index)} x2={x(d.index)} y1={PAD_TOP} y2={y(0)} />
            ))}

            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={y(0)} />}
          </svg>
        )}
        {hovered && hover !== null && (
          <div className="tooltip" aria-hidden style={{ left: Math.min(x(hover) + 12, width - 200) }}>
            <div className="tooltip-title">{bucketLabel(hovered.key, true)}</div>
            {lines.map((l) => (
              <div key={l.id} className="tooltip-row">
                <span className="tooltip-key" style={{ background: l.color }} />
                <span className="tooltip-label">{l.label}</span>
                <strong>{format(l.values[hover])}</strong>
              </div>
            ))}
            <div className="tooltip-row tooltip-total">
              <span>Total</span>
              <strong>{format(lines.reduce((n, l) => n + l.values[hover], 0))}</strong>
            </div>
          </div>
        )}
      </div>
      {days.length ? (
        <div className="uchart-x uchart-x-days mono">
          {days.map((d, i) => (
            <span key={d.index} style={{ left: (x(d.index) + x(days[i + 1]?.index ?? count - 1)) / 2 }}>
              {weekdayLabel(d.day)}
            </span>
          ))}
        </div>
      ) : (
        <div className="uchart-x mono">
          {labels.map((i) => (
            <span key={i}>{bucketLabel(summary.series[i].key)}</span>
          ))}
        </div>
      )}
    </div>
  )
}
