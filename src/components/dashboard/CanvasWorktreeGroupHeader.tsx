import { memo, useCallback, useEffect, useRef } from 'react'
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { DropIndicator } from '@/components/drag-and-drop/DropIndicator'
import { DisclosureChevron } from '@/components/projects/DisclosureChevron'
import type { WorktreeGroupHeaderHighlight } from '@/components/projects/WorktreeGroupHeader'
import { StatusIndicator } from '@/components/ui/status-indicator'
import {
  DRAG_SCOPE_CANVAS_WORKTREE_LIST,
  DRAG_TYPE_WORKTREE_GROUP,
  DROP_TYPE_WORKTREE_GROUP_HEADER,
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
  /** True: no drop target and no drag (search, tab, mobile, pending save) */
  dragDisabled?: boolean
  /** Stable: whether the dragged item (pdnd source data) may drop here */
  canDropOnHeader?: (
    sourceData: Record<string, unknown>,
    groupId: string
  ) => boolean
  highlight?: WorktreeGroupHeaderHighlight
  isDragging?: boolean
}

/**
 * Group header on the project canvas. Toggles collapse, is a drop target for
 * rows and (not Ungrouped) drags to reorder groups. Rename, delete and new
 * group live in the sidebar header.
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
    dragDisabled = true,
    canDropOnHeader,
    highlight = null,
    isDragging = false,
  }: CanvasWorktreeGroupHeaderProps) {
    const groupDomId = groupId ?? UNGROUPED_GROUP_ID
    const headerRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const element = headerRef.current
      if (!element || dragDisabled || !canDropOnHeader) return
      const data = {
        projectId,
        groupId: groupDomId,
        scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
      }
      const cleanups = [
        dropTargetForElements({
          element,
          canDrop: ({ source }) => canDropOnHeader(source.data, groupDomId),
          getData: ({ input, element }) =>
            attachClosestEdge(
              { type: DROP_TYPE_WORKTREE_GROUP_HEADER, ...data },
              { input, element, allowedEdges: ['top', 'bottom'] }
            ),
        }),
      ]
      // Ungrouped is never dragged.
      if (groupId) {
        cleanups.push(
          draggable({
            element,
            getInitialData: () => ({ type: DRAG_TYPE_WORKTREE_GROUP, ...data }),
          })
        )
      }
      return combine(...cleanups)
    }, [canDropOnHeader, dragDisabled, groupDomId, groupId, projectId])

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
        ref={headerRef}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-label={`${name} group, ${count} worktrees`}
        data-worktree-group-id={groupDomId}
        data-worktree-group-project-id={projectId}
        data-worktree-group-scope={DRAG_SCOPE_CANVAS_WORKTREE_LIST}
        data-drop-highlight={highlight === 'combine' ? 'combine' : undefined}
        className={cn(
          'relative flex cursor-pointer select-none items-center gap-1.5 rounded px-3 font-medium text-muted-foreground transition-[color,background-color,opacity] first:mt-0',
          'hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          compact
            ? 'mt-2 py-1.5 text-xs'
            : 'mt-3 py-1 text-2xs uppercase tracking-wide',
          highlight === 'combine' &&
            'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/50',
          isDragging && 'opacity-40'
        )}
        onClick={toggle}
        onKeyDown={handleKeyDown}
      >
        <DropIndicator
          edge={highlight === 'combine' ? null : highlight}
          insetClassName="left-0 right-0"
        />
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
