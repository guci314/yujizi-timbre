/** 秒数 → `m:ss` / `h:mm:ss`。放在外壳里，因为纯业务模型不该关心怎么排版。 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** 睡眠香剩多少秒 → `m:ss`。 */
export function formatCountdown(seconds: number): string {
  return formatClock(Math.max(0, seconds))
}
