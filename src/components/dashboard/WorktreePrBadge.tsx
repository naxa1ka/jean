import { memo } from 'react'
import { GitMerge, GitPullRequestArrow } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getPrStatusDisplay } from '@/components/chat/toolbar/toolbar-utils'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { usePrStatus } from '@/services/pr-status'
import type { PrDisplayStatus } from '@/types/pr-status'
import type { Worktree } from '@/types/projects'

interface WorktreePrBadgeProps {
  worktree: Pick<Worktree, 'id' | 'pr_number' | 'pr_url' | 'cached_pr_status'>
  /** Mobile layout: bigger touch target, no tooltip. */
  compact?: boolean
}

/** Worktree row capsule for the linked PR. A click opens the PR. */
export const WorktreePrBadge = memo(function WorktreePrBadge({
  worktree,
  compact = false,
}: WorktreePrBadgeProps) {
  const { pr_number: prNumber, pr_url: prUrl } = worktree
  const { data: prStatus } = usePrStatus(prUrl ? worktree.id : null)
  if (!prNumber || !prUrl) return null

  const status =
    prStatus?.display_status ??
    (worktree.cached_pr_status as PrDisplayStatus | undefined)
  const display = status ? getPrStatusDisplay(status) : null
  const Icon = status === 'merged' ? GitMerge : GitPullRequestArrow
  const label = display
    ? `${display.label} · PR #${prNumber}`
    : `PR #${prNumber}`

  const button = (
    <button
      type="button"
      aria-label={`Open ${label}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border border-current/30 px-1.5 py-0.5 text-2xs font-medium tabular-nums transition-opacity hover:opacity-70',
        display?.className ?? 'text-muted-foreground',
        compact && '-my-1.5 py-1.5'
      )}
      onClick={e => {
        e.stopPropagation()
        void openExternal(prUrl)
      }}
      onKeyDown={e => e.stopPropagation()}
    >
      <Icon className="size-3" />#{prNumber}
    </button>
  )

  if (compact) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})
