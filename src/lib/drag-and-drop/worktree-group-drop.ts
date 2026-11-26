import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import {
  canGroupWorktree,
  effectiveGroupId,
  orderForMoveToGroupEnd,
} from '@/lib/worktree-groups'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import { UNGROUPED_GROUP_ID } from './types'

export type WorktreeGroupDropSource =
  | { kind: 'worktree'; projectId: string; worktreeId: string }
  | { kind: 'group'; projectId: string; groupId: string }

export type WorktreeGroupDropTarget =
  | { kind: 'row'; projectId: string; worktreeId: string; edge: Edge | null }
  /** `groupId` is a group UUID or `UNGROUPED_GROUP_ID` */
  | { kind: 'header'; projectId: string; groupId: string; edge: Edge | null }

export type WorktreeGroupDropResult =
  | { kind: 'reorder'; worktreeIds: string[] }
  | { kind: 'move'; groupId: string | null; worktreeIds: string[] }
  | { kind: 'reorderGroups'; groupIds: string[] }

export interface ResolveWorktreeGroupDropInput {
  projectId: string
  /**
   * Full ordered list of reorderable rows of the project (base session and
   * rows of collapsed groups included, pending rows left out).
   */
  fullOrderedIds: readonly string[]
  worktreesById: ReadonlyMap<string, Worktree>
  /** Groups of the project; empty when the server has no group support. */
  groups: readonly WorktreeGroup[]
  source: WorktreeGroupDropSource
  target: WorktreeGroupDropTarget
}

function sortedGroupIds(groups: readonly WorktreeGroup[]): string[] {
  return [...groups]
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    )
    .map(g => g.id)
}

function insertRelative(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  edge: Edge | null
): string[] | null {
  const rest = ids.filter(id => id !== movedId)
  const targetIndex = rest.indexOf(targetId)
  if (targetIndex === -1) return null
  const insertAt = edge === 'bottom' ? targetIndex + 1 : targetIndex
  return [...rest.slice(0, insertAt), movedId, ...rest.slice(insertAt)]
}

/**
 * What a drop in a grouped worktree list does. Pure: the caller maps the
 * result to `reorder_worktrees`, `move_worktree_to_group` or
 * `reorder_worktree_groups`. `worktreeIds` is always the full ordered list
 * with the move applied. Returns null when the drop is not allowed.
 */
export function resolveWorktreeGroupDrop({
  projectId,
  fullOrderedIds,
  worktreesById,
  groups,
  source,
  target,
}: ResolveWorktreeGroupDropInput): WorktreeGroupDropResult | null {
  if (source.projectId !== projectId || target.projectId !== projectId) {
    return null
  }

  if (source.kind === 'group') {
    if (target.kind !== 'header') return null
    if (source.groupId === target.groupId) return null
    const groupIds = sortedGroupIds(groups)
    if (!groupIds.includes(source.groupId)) return null
    // Ungrouped is not in `groups`, so it is never a group-drag target.
    if (!groupIds.includes(target.groupId)) return null
    const next = insertRelative(
      groupIds,
      source.groupId,
      target.groupId,
      target.edge
    )
    return next ? { kind: 'reorderGroups', groupIds: next } : null
  }

  const moved = worktreesById.get(source.worktreeId)
  if (!moved || moved.project_id !== projectId || !canGroupWorktree(moved)) {
    return null
  }
  if (!fullOrderedIds.includes(moved.id)) return null
  const sourceGroupId = effectiveGroupId(moved, groups)

  if (target.kind === 'header') {
    // Headers exist only when the project has groups.
    if (groups.length === 0) return null
    const groupId =
      target.groupId === UNGROUPED_GROUP_ID ? null : target.groupId
    if (groupId !== null && !groups.some(g => g.id === groupId)) return null
    const worktreeIds = orderForMoveToGroupEnd(
      fullOrderedIds,
      worktreesById,
      moved.id,
      groupId,
      groups
    )
    return groupId === sourceGroupId
      ? { kind: 'reorder', worktreeIds }
      : { kind: 'move', groupId, worktreeIds }
  }

  if (target.worktreeId === moved.id) return null
  const over = worktreesById.get(target.worktreeId)
  if (!over || over.project_id !== projectId || !canGroupWorktree(over)) {
    return null
  }
  const worktreeIds = insertRelative(
    fullOrderedIds,
    moved.id,
    over.id,
    target.edge
  )
  if (!worktreeIds) return null
  const targetGroupId = effectiveGroupId(over, groups)
  return targetGroupId === sourceGroupId
    ? { kind: 'reorder', worktreeIds }
    : { kind: 'move', groupId: targetGroupId, worktreeIds }
}
