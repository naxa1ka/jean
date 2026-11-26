import { memo, useCallback } from 'react'
import { DisclosureChevron } from '@/components/projects/DisclosureChevron'
import { StatusIndicator } from '@/components/ui/status-indicator'
import {
  DRAG_SCOPE_CANVAS_WORKTREE_LIST,
  UNGROUPED_GROUP_ID,
} from '@/lib/drag-and-drop/types'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/store/projects-store'

interface CanvasWorktreeGroupHeaderProps {
  projectId: string
  /** null = Ungrouped */
  groupId: string | null
  name: string
  collapseKey: string
  isCollapsed: boolean
  count: number
  status: 'waiting' | 'running' | null
  compact?: boolean
}

/**
 * Group header on the project canvas. Only toggles collapse: rename, delete
 * and new group live in the sidebar header.
 */
export const CanvasWorktreeGroupHeader = memo(
  function CanvasWorktreeGroupHeader({
    projectId,
    groupId,
    name,
    collapseKey,
    isCollapsed,
    count,
    status,
    compact = false,
  }: CanvasWorktreeGroupHeaderProps) {
    const toggle = useCallback(() => {
      useProjectsStore.getState().toggleWorktreeGroupCollapsed(collapseKey)
    }, [collapseKey])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        // The canvas keyboard nav listens for Enter on window: keep it from
        // also opening the selected worktree.
        e.preventDefault()
        e.stopPropagation()
        toggle()
      },
      [toggle]
    )

    return (
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-label={`${name} group, ${count} worktrees`}
        data-worktree-group-id={groupId ?? UNGROUPED_GROUP_ID}
        data-worktree-group-project-id={projectId}
        data-worktree-group-scope={DRAG_SCOPE_CANVAS_WORKTREE_LIST}
        className={cn(
          'flex cursor-pointer select-none items-center gap-1.5 rounded px-3 font-medium text-muted-foreground transition-colors first:mt-0',
          'hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          compact
            ? 'mt-2 py-1.5 text-xs'
            : 'mt-3 py-1 text-2xs uppercase tracking-wide'
        )}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <DisclosureChevron open={!isCollapsed} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
        <span
          className="shrink-0 tabular-nums text-muted-foreground/60"
          data-testid="worktree-group-count"
        >
          {count}
        </span>
        {status && (
          <StatusIndicator
            status={status}
            label={status === 'waiting' ? 'Needs input' : 'Running'}
            className="h-1.5 w-1.5 shrink-0"
          />
        )}
      </div>
    )
  }
)
