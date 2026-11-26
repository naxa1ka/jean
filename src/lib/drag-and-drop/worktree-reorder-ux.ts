import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import {
  isWorktreeDropTargetData,
  isWorktreeGroupHeaderDropTargetData,
  type WorktreeDropTargetData,
} from './types'

export type WorktreeDropTargetKind = 'row' | 'header'

export interface WorktreeReorderDragState {
  draggingId: string | null
  targetId: string | null
  closestEdge: Edge | null
  /** Target kind; absent = 'row' */
  kind?: WorktreeDropTargetKind
  /** Header targets: group UUID or `UNGROUPED_GROUP_ID` */
  groupId?: string
}

export interface WorktreeDropSnapshot {
  /** Row: worktree id. Header: the header group id. */
  targetId: string | null
  closestEdge: Edge | null
  /** Target kind; absent = 'row' */
  kind?: WorktreeDropTargetKind
  /** Header targets: group UUID or `UNGROUPED_GROUP_ID` */
  groupId?: string
}

export const emptyWorktreeDropSnapshot: WorktreeDropSnapshot = {
  targetId: null,
  closestEdge: null,
}

export function getClosestVerticalEdge({
  clientY,
  rect,
}: {
  clientY: number
  rect: Pick<DOMRect, 'top' | 'height'>
}): Edge {
  return clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
}

export function getWorktreeDropTargetForScope(
  dropTargets: { data: Record<string | symbol, unknown> }[],
  scope: WorktreeDropTargetData['scope']
) {
  return dropTargets.find(
    dropTarget =>
      isWorktreeDropTargetData(dropTarget.data) &&
      dropTarget.data.scope === scope
  )
}

export function getSnapshotFromWorktreeDropTarget(
  dropTarget: { data: Record<string | symbol, unknown> } | undefined
): WorktreeDropSnapshot {
  if (!dropTarget || !isWorktreeDropTargetData(dropTarget.data)) {
    return emptyWorktreeDropSnapshot
  }

  return {
    targetId:
      typeof dropTarget.data.worktreeId === 'string'
        ? dropTarget.data.worktreeId
        : null,
    closestEdge: extractClosestEdge(dropTarget.data),
  }
}

export function getWorktreeElementFromEventTarget({
  eventTarget,
  scope,
}: {
  eventTarget: EventTarget | null
  scope: WorktreeDropTargetData['scope']
}): HTMLElement | null {
  return (
    (eventTarget as HTMLElement | null)?.closest(
      `[data-pdnd-worktree-scope="${scope}"]`
    ) ?? null
  )
}

export function getWorktreeElementFromPoint({
  clientX,
  clientY,
  scope,
}: {
  clientX: number
  clientY: number
  scope: WorktreeDropTargetData['scope']
}): HTMLElement | null {
  const element = document.elementFromPoint(
    clientX,
    clientY
  ) as HTMLElement | null
  return getWorktreeElementFromEventTarget({ eventTarget: element, scope })
}

export function getSnapshotFromWorktreeElement({
  element,
  draggingId,
  clientY,
}: {
  element: HTMLElement | null
  draggingId: string
  clientY: number
}): WorktreeDropSnapshot {
  const targetId = element?.dataset.pdndWorktreeId ?? null
  if (!element || !targetId || targetId === draggingId) {
    return emptyWorktreeDropSnapshot
  }

  return {
    targetId,
    closestEdge: getClosestVerticalEdge({
      clientY,
      rect: element.getBoundingClientRect(),
    }),
  }
}

export function applyWorktreeDropSnapshot<T extends WorktreeReorderDragState>(
  state: T,
  snapshot: WorktreeDropSnapshot
): T {
  if (
    state.targetId === snapshot.targetId &&
    state.closestEdge === snapshot.closestEdge &&
    (state.kind ?? 'row') === (snapshot.kind ?? 'row') &&
    state.groupId === snapshot.groupId
  ) {
    return state
  }

  return {
    ...state,
    targetId: snapshot.targetId,
    closestEdge: snapshot.closestEdge,
    kind: snapshot.kind,
    groupId: snapshot.groupId,
  }
}

/** CSS selector of the group headers of one project in one list scope. */
export function worktreeGroupHeaderSelector(scope: string, projectId: string) {
  return `[data-worktree-group-scope="${scope}"][data-worktree-group-project-id="${CSS.escape(projectId)}"]`
}

/** Innermost row or group-header drop target of one list (scope + project). */
export function getWorktreeListDropSnapshot(
  dropTargets: { data: Record<string | symbol, unknown> }[],
  scope: WorktreeDropTargetData['scope'],
  projectId: string
): WorktreeDropSnapshot {
  for (const dropTarget of dropTargets) {
    const data = dropTarget.data
    if (
      isWorktreeDropTargetData(data) &&
      data.scope === scope &&
      data.projectId === projectId
    ) {
      return getSnapshotFromWorktreeDropTarget(dropTarget)
    }
    if (
      isWorktreeGroupHeaderDropTargetData(data) &&
      data.scope === scope &&
      data.projectId === projectId
    ) {
      return {
        targetId: data.groupId,
        closestEdge: extractClosestEdge(data),
        kind: 'header',
        groupId: data.groupId,
      }
    }
  }
  return emptyWorktreeDropSnapshot
}

/**
 * Native fallback: the row or group header under `eventTarget`, only inside
 * `container` and only for this scope + project.
 */
export function getWorktreeListElement({
  eventTarget,
  container,
  scope,
  projectId,
}: {
  eventTarget: EventTarget | null
  container: HTMLElement | null
  scope: WorktreeDropTargetData['scope']
  projectId: string
}): HTMLElement | null {
  if (!container || !(eventTarget instanceof Element)) return null
  const element = eventTarget.closest<HTMLElement>(
    `[data-pdnd-worktree-scope="${scope}"], ${worktreeGroupHeaderSelector(scope, projectId)}`
  )
  return element && container.contains(element) ? element : null
}

/** Native fallback snapshot of a row or group-header element. */
export function getSnapshotFromWorktreeListElement({
  element,
  draggingId,
  clientY,
}: {
  element: HTMLElement | null
  draggingId: string
  clientY: number
}): WorktreeDropSnapshot {
  const groupId = element?.dataset.worktreeGroupId
  if (!element || !groupId) {
    return getSnapshotFromWorktreeElement({ element, draggingId, clientY })
  }
  if (groupId === draggingId) return emptyWorktreeDropSnapshot
  return {
    targetId: groupId,
    closestEdge: getClosestVerticalEdge({
      clientY,
      rect: element.getBoundingClientRect(),
    }),
    kind: 'header',
    groupId,
  }
}
