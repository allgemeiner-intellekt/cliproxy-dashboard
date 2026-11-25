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
  const [hover, setHover] = useState<number | null>(null)
  // Set while the hovered bucket was picked with the keyboard, so only those
  // moves are announced (pointer moves would flood a screen reader).
  const [keyboard, setKeyboard] = useState(false)

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
    setKeyboard(false)
    setHover(i >= 0 && i < count ? i : null)
  }

  // Arrow keys step through the buckets; Home and End jump to either end.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!count) return
    const at = hover ?? count - 1
    const next = chartKeyTarget(e.key, at, count)
    if (next === undefined) return
    e.preventDefault()
    setKeyboard(next !== null)
    setHover(next)
  }

  const unit = summary.bucket === 'hour' ? 'hour' : 'day'
  const chartLabel = `${metric === 'cost' ? 'Cost' : 'Tokens'} over time by ${by}`

  const days = summary.range === '7d' ? dayStarts(summary) : []
  // First, middle and last; fewer when there are only one or two buckets.
  const labels = [...new Set(count ? [0, Math.floor((count - 1) / 2), count - 1] : [])]
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
        tabIndex={count ? 0 : undefined}
        role="group"
        aria-roledescription="chart"
        aria-label={count ? `${chartLabel}. Use the arrow keys to read each ${unit}.` : chartLabel}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (hover === null && count) {
            setKeyboard(true)
            setHover(count - 1)
          }
        }}
        onBlur={() => {
          setKeyboard(false)
          setHover(null)
        }}
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} onPointerMove={onMove} onPointerLeave={() => !keyboard && setHover(null)} aria-hidden>
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
        <div className="sr-only" aria-live="polite">
          {keyboard && hovered && hover !== null ? describeBucket(bucketLabel(hovered.key, true), lines, hover, format) : ''}
        </div>
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
