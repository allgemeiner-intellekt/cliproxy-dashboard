// Bounds for stored request times. Usage can't predate these tools, and a
// timestamp far outside the range is corrupt or forged; letting it in would
// stretch the "all" range across centuries of empty days.

const DAY = 86400e3

export const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1)

// Allows a day of clock skew into the future.
export function isPlausibleTimestamp(ms: number, now = Date.now()) {
  return Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE_MS && ms <= now + DAY
}
