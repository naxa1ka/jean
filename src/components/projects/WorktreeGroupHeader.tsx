import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  attachClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { FolderPlus, Pencil, Trash2 } from '@/components/icons/reicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { DropIndicator } from '@/components/drag-and-drop/DropIndicator'
import {
  DRAG_TYPE_WORKTREE_GROUP,
  DROP_TYPE_WORKTREE_GROUP_HEADER,
  UNGROUPED_GROUP_ID,
  type WorktreeDragData,
} from '@/lib/drag-and-drop/types'
import { cn } from '@/lib/utils'
import { worktreeGroupCollapseKey } from '@/lib/worktree-groups'
import { getWorktreeGroupActivity } from '@/lib/worktree-groups-activity'
import {
  useDeleteWorktreeGroup,
  useRenameWorktreeGroup,
} from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import type { WorktreeSessions } from '@/types/chat'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import { DisclosureChevron } from './DisclosureChevron'
import { useCreateWorktreeGroupAndRename } from './useCreateWorktreeGroupAndRename'

/** Drop highlight of a header: worktree "into group", or a group-reorder edge. */
export type WorktreeGroupHeaderHighlight = 'combine' | Edge | null

interface WorktreeGroupHeaderProps {
  projectId: string
  /** null = the Ungrouped header (no menu, no rename) */
  group: WorktreeGroup | null
  worktrees: readonly Worktree[]
  sessionsByWorktreeId: ReadonlyMap<string, WorktreeSessions>
  scope: WorktreeDragData['scope']
  /** No drag wiring when true (touch, mutation in flight, no drag support). */
  dragDisabled?: boolean
  /** Stable: whether the dragged item (pdnd source data) may drop on this header. */
  canDropOnHeader?: (
    sourceData: Record<string, unknown>,
    groupId: string
  ) => boolean
  highlight?: WorktreeGroupHeaderHighlight
  isDragging?: boolean
}

export const WorktreeGroupHeader = memo(function WorktreeGroupHeader({
  projectId,
  group,
  worktrees,
  sessionsByWorktreeId,
  scope,
  dragDisabled = true,
  canDropOnHeader,
  highlight = null,
  isDragging = false,
}: WorktreeGroupHeaderProps) {
  const groupDomId = group?.id ?? UNGROUPED_GROUP_ID
  const collapseKey = worktreeGroupCollapseKey(projectId, group?.id ?? null)
  const isCollapsed = useProjectsStore(state =>
    state.collapsedWorktreeGroupKeys.has(collapseKey)
  )
  const isEditing = useProjectsStore(
    state => group !== null && state.editingWorktreeGroupId === group.id
  )
  const memberIds = useMemo(() => worktrees.map(w => w.id), [worktrees])
  const activity = useChatStore(
    useShallow(state =>
      getWorktreeGroupActivity(state, memberIds, sessionsByWorktreeId)
    )
  )
  const name = group?.name ?? 'Ungrouped'

  const [editName, setEditName] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const editStartTimeRef = useRef(0)
  const renameGroup = useRenameWorktreeGroup()
  const deleteGroup = useDeleteWorktreeGroup()
  const createGroup = useCreateWorktreeGroupAndRename()

  useEffect(() => {
    if (isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditName(name)
      editStartTimeRef.current = Date.now()
    }
  }, [isEditing, name])

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const toggle = useCallback(() => {
    if (isEditing) return
    useProjectsStore.getState().toggleWorktreeGroupCollapsed(collapseKey)
  }, [collapseKey, isEditing])

  const startEditing = useCallback(() => {
    if (!group) return
    useProjectsStore.getState().setEditingWorktreeGroupId(group.id)
  }, [group])

  const handleSubmitRename = useCallback(
    (fromBlur = false) => {
      if (!group) return
      // Ignore blur right after edit start (menu close / re-render blur)
      if (fromBlur && Date.now() - editStartTimeRef.current < 300) {
        inputRef.current?.focus()
        return
      }
      const trimmed = editName.trim()
      if (trimmed && trimmed !== group.name) {
        renameGroup.mutate({ projectId, groupId: group.id, name: trimmed })
      }
      useProjectsStore.getState().setEditingWorktreeGroupId(null)
    },
    [editName, group, projectId, renameGroup]
  )

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        handleSubmitRename(false)
      } else if (e.key === 'Escape') {
        setEditName(name)
        useProjectsStore.getState().setEditingWorktreeGroupId(null)
      }
    },
    [handleSubmitRename, name]
  )

  const handleHeaderKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    },
    [toggle]
  )

  const handleDelete = useCallback(() => {
    if (!group) return
    deleteGroup.mutate(
      { projectId, groupId: group.id },
      {
        onSuccess: () =>
          toast.success('Group deleted. Its worktrees moved to Ungrouped.'),
      }
    )
  }, [deleteGroup, group, projectId])

  const handleNewGroup = useCallback(() => {
    void createGroup(projectId)
  }, [createGroup, projectId])

  const headerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = headerRef.current
    if (!element || dragDisabled || !canDropOnHeader) return
    const data = {
      projectId,
      groupId: groupDomId,
      scope,
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
    // Ungrouped is never dragged; renaming keeps text selection.
    if (group && !isEditing) {
      cleanups.push(
        draggable({
          element,
          canDrag: () => !isEditing,
          getInitialData: () => ({ type: DRAG_TYPE_WORKTREE_GROUP, ...data }),
        })
      )
    }
    return combine(...cleanups)
  }, [
    canDropOnHeader,
    dragDisabled,
    group,
    groupDomId,
    isEditing,
    projectId,
    scope,
  ])

  const status = activity.waiting
    ? 'waiting'
    : activity.running
      ? 'running'
      : null

  const header = (
    <div
      ref={headerRef}
      role="button"
      tabIndex={0}
      aria-expanded={!isCollapsed}
      aria-label={`${name} group, ${worktrees.length} worktrees`}
      data-worktree-group-id={groupDomId}
      data-worktree-group-project-id={projectId}
      data-worktree-group-scope={scope}
      className={cn(
        'group relative flex cursor-pointer select-none items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground/80 transition-[color,background-color,opacity] duration-150',
        'hover:bg-accent/50 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        highlight === 'combine' &&
          'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/50',
        isDragging && 'opacity-40'
      )}
      data-drop-highlight={highlight === 'combine' ? 'combine' : undefined}
      onClick={toggle}
      onDoubleClick={e => {
        e.stopPropagation()
        startEditing()
      }}
      onKeyDown={handleHeaderKeyDown}
    >
      <DropIndicator
        edge={highlight === 'combine' ? null : highlight}
        insetClassName="left-2 right-2"
      />
      <DisclosureChevron open={!isCollapsed} className="size-3 shrink-0" />
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editName}
          maxLength={60}
          onChange={e => setEditName(e.target.value)}
          onBlur={() => handleSubmitRename(true)}
          onKeyDown={handleRenameKeyDown}
          aria-label="Rename group"
          className="min-w-0 flex-1 rounded bg-transparent px-1 text-base outline-none ring-1 ring-primary/50 md:text-xs"
          onClick={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          autoFocus
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{name}</span>
      )}
      {status && (
        <StatusIndicator
          status={status}
          label={status === 'waiting' ? 'Needs input' : 'Running'}
          className="h-1.5 w-1.5 shrink-0"
        />
      )}
      <span
        className="shrink-0 tabular-nums text-2xs text-muted-foreground/60"
        data-testid="worktree-group-count"
      >
        {worktrees.length}
      </span>
    </div>
  )

  if (!group) return header

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={startEditing}>
          <Pencil className="mr-2 h-4 w-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={handleNewGroup}>
          <FolderPlus className="mr-2 h-4 w-4" />
          New group
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete group
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
