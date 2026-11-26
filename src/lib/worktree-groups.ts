import { compareWorktreesForCanvasSort } from '@/components/projects/worktree-sort-utils'
import {
  isBaseSession,
  type Worktree,
  type WorktreeGroup,
} from '@/types/projects'

export interface WorktreeGroupBucket {
  group: WorktreeGroup
  worktrees: Worktree[]
}

export interface GroupedWorktrees {
  base: Worktree | null
  pending: Worktree[]
  groups: WorktreeGroupBucket[]
  ungrouped: Worktree[]
}

/** Groups sorted by `order`, ties by name then id. */
function sortGroups(groups: readonly WorktreeGroup[]): WorktreeGroup[] {
  return [...groups].sort(
    (a, b) =>
      a.order - b.order ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  )
}

/**
 * The group a worktree shows in: its `group_id` when that group exists, else
 * null (ungrouped). Base sessions and auto-fix worktrees are never grouped.
 */
export function effectiveGroupId(
  worktree: Worktree,
  groups: readonly WorktreeGroup[] | undefined
): string | null {
  const groupId = worktree.group_id
  if (!groupId || isBaseSession(worktree) || worktree.origin === 'auto_fix') {
    return null
  }
  return groups?.some(g => g.id === groupId) ? groupId : null
}

/** Base sessions, auto-fix worktrees and worktrees in flight cannot be grouped. */
export function canGroupWorktree(worktree: Worktree): boolean {
  if (isBaseSession(worktree)) return false
  if (worktree.origin === 'auto_fix') return false
  const status = worktree.status
  return status === undefined || status === 'ready' || status === 'error'
}

/**
 * Split already sorted worktrees into display buckets. Every bucket keeps the
 * incoming order. All groups are returned (sorted by `order`), empty ones too.
 */
export function groupWorktrees(
  sortedWorktrees: readonly Worktree[],
  groups: readonly WorktreeGroup[] | undefined
): GroupedWorktrees {
  const buckets = sortGroups(groups ?? []).map(group => ({
    group,
    worktrees: [] as Worktree[],
  }))
  const bucketById = new Map(buckets.map(b => [b.group.id, b]))
  const result: GroupedWorktrees = {
    base: null,
    pending: [],
    groups: buckets,
    ungrouped: [],
  }

  for (const worktree of sortedWorktrees) {
    if (isBaseSession(worktree)) {
      result.base ??= worktree
      continue
    }
    if (worktree.status === 'pending') {
      result.pending.push(worktree)
      continue
    }
    const groupId = effectiveGroupId(worktree, groups)
    const bucket = groupId ? bucketById.get(groupId) : undefined
    if (bucket) bucket.worktrees.push(worktree)
    else result.ungrouped.push(worktree)
  }
  return result
}

/**
 * Full order with `movedId` placed right after the last member of the target
 * group, or at the end when the group has no other members or the target is
 * ungrouped (null).
 */
export function orderForMoveToGroupEnd(
  fullOrderedIds: readonly string[],
  worktreesById: ReadonlyMap<string, Worktree>,
  movedId: string,
  targetGroupId: string | null,
  groups: readonly WorktreeGroup[] | undefined
): string[] {
  const rest = fullOrderedIds.filter(id => id !== movedId)
  let insertAt = rest.length
  if (targetGroupId) {
    for (let index = rest.length - 1; index >= 0; index--) {
      const id = rest[index]
      const worktree = id ? worktreesById.get(id) : undefined
      if (worktree && effectiveGroupId(worktree, groups) === targetGroupId) {
        insertAt = index + 1
        break
      }
    }
  }
  return [...rest.slice(0, insertAt), movedId, ...rest.slice(insertAt)]
}

/**
 * The full persisted manual order of a project's worktrees: base session
 * first, then by `order`. Skips pending, deleting and auto-fix worktrees.
 */
export function persistedWorktreeOrder(
  worktrees: readonly Worktree[]
): string[] {
  const noActivity = new Map<string, number>()
  return worktrees
    .filter(
      w =>
        w.status !== 'pending' &&
        w.status !== 'deleting' &&
        w.origin !== 'auto_fix'
    )
    .sort((a, b) => compareWorktreesForCanvasSort(a, b, noActivity, 'manual'))
    .map(w => w.id)
}

/**
 * Whether two worktrees show in the same group (both ungrouped counts). The
 * sidebar reorder drag only drops inside one group; unknown ids never match.
 */
export function isSameWorktreeGroup(
  sourceId: string,
  targetId: string,
  worktreesById: ReadonlyMap<string, Worktree>,
  groups: readonly WorktreeGroup[] | undefined
): boolean {
  const source = worktreesById.get(sourceId)
  const target = worktreesById.get(targetId)
  if (!source || !target) return false
  return effectiveGroupId(source, groups) === effectiveGroupId(target, groups)
}

/** Collapse key of a group header: the group UUID, or the project id for Ungrouped. */
export function worktreeGroupCollapseKey(
  projectId: string,
  groupId: string | null
): string {
  return groupId ?? projectId
}
