import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { usePlanQueueAction } from '@/services/plan-queue'
import { useUIStore } from '@/store/ui-store'
import type { PlanQueueSummary } from '@/types/plan-queue'
import type { Worktree } from '@/types/projects'
import { planQueueStatusText } from './plan-queue-utils'

export function openPlanQueueDialog(worktree: Worktree) {
  useUIStore.getState().setPlanQueueTarget({
    id: worktree.id,
    path: worktree.path,
    project_id: worktree.project_id,
    name: worktree.name,
  })
}

/** Pause or resume a worktree queue. Errors show a toast (see the mutation). */
export function usePlanQueueToggle() {
  const action = usePlanQueueAction()
  return (summary: PlanQueueSummary) =>
    action.mutate({
      worktreeId: summary.worktreeId,
      action: summary.paused ? 'resume' : 'pause',
    })
}

/**
 * Queue strip under a canvas worktree row, styled like `MrRobotProgress`.
 * `compact` (mobile): one muted line; Pause/Resume is in the long-press menu.
 */
export function PlanQueueProgress({
  worktree,
  summary,
  compact = false,
}: {
  worktree: Worktree
  summary: PlanQueueSummary
  compact?: boolean
}) {
  const toggle = usePlanQueueToggle()
  const running = Boolean(summary.runningPlan)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [running])

  const text = planQueueStatusText(summary, now)
  const attention = summary.blocked || Boolean(summary.waitReason)
  const label = (
    <button
      type="button"
      className={cn(
        'min-w-0 truncate text-left hover:underline',
        attention && !compact ? 'text-warning' : 'text-muted-foreground'
      )}
      title={text}
      onClick={() => openPlanQueueDialog(worktree)}
    >
      {text}
    </button>
  )

  if (compact) return <div className="flex px-3 pb-2 text-xs">{label}</div>

  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-2 text-xs">
      {label}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 text-xs"
        onClick={() => toggle(summary)}
      >
        {summary.paused ? 'Resume' : 'Pause'}
      </Button>
    </div>
  )
}
