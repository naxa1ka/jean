/**
 * Moves the plan at `index` by `delta` places. Returns the new order, or null
 * when the move goes past either end (no reorder call needed).
 */
export function movePlan(
  names: readonly string[],
  index: number,
  delta: number
): string[] | null {
  const target = index + delta
  if (delta === 0 || index < 0 || index >= names.length) return null
  if (target < 0 || target >= names.length) return null
  const next = [...names]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved as string)
  return next
}

/** "45s", "4m", "2h 5m" since `startedAt`. Empty when the date is missing or bad. */
export function formatElapsed(
  startedAt: string | undefined,
  now: number
): string {
  if (!startedAt) return ''
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return ''
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** Drop events give File objects; only `.md` files are plans. */
export function isMarkdownFile(file: Pick<File, 'name'>): boolean {
  return file.name.toLowerCase().endsWith('.md')
}
