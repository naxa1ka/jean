import type { PlanQueueSummary } from '@/types/plan-queue'

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

/**
 * One-line queue status for the canvas progress strip. Blocked, stuck and
 * paused win over a running plan, because they tell the user to act. Failed
 * plans count as passed in the position and get a `· N failed` suffix.
 */
export function planQueueStatusText(
  summary: PlanQueueSummary,
  now: number
): string {
  if (summary.blocked) return 'Queue blocked'
  if (summary.orphaned) return 'Queue stuck: plan left in running/'
  if (summary.paused) return 'Queue paused'
  const position = `${summary.total - summary.pending}/${summary.total}`
  const failed =
    summary.failedCount > 0 ? ` · ${summary.failedCount} failed` : ''
  if (summary.runningPlan) {
    const name = summary.runningPlan.replace(/\.md$/i, '')
    const elapsed = formatElapsed(summary.runningSince, now)
    return `Queue ${position} · running ${name}${elapsed ? ` · ${elapsed}` : ''}${failed}`
  }
  if (summary.waitReason) return `Queue waiting: ${summary.waitReason}`
  if (summary.pending > 0)
    return `Queue ${position} · ${summary.pending} pending${failed}`
  return failed ? `Queue ${position}${failed}` : `Queue ${position} · done`
}

/** Status the user must act on: shown in the warning color. */
export function planQueueNeedsAttention(summary: PlanQueueSummary): boolean {
  return (
    summary.blocked ||
    summary.orphaned ||
    summary.failedCount > 0 ||
    Boolean(summary.waitReason)
  )
}

/** Pause/Resume does nothing for a drained queue, so hide it there. */
export function planQueueCanToggle(summary: PlanQueueSummary): boolean {
  return summary.paused || summary.pending > 0 || Boolean(summary.runningPlan)
}
