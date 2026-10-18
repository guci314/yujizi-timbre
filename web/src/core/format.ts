const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Human-readable size, one decimal above KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[exponent]}`
}

/** Share of a whole, clamped to 0..1. Zero total reads as no progress. */
export function ratio(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.min(1, Math.max(0, part / whole))
}
