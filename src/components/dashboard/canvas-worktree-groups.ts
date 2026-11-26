import {
  effectiveGroupId,
  groupWorktrees,
  worktreeGroupCollapseKey,
} from '@/lib/worktree-groups'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import { sortByCanvasRowState, type CanvasRowState } from './canvas-row-state'

interface CanvasSectionLike {
  worktree: Worktree
  isPending?: boolean
}

export interface CanvasGroupHeaderItem {
  kind: 'header'
  /** null = Ungrouped */
  group: WorktreeGroup | null
  collapseKey: string
  isCollapsed: boolean
  /** Rows shown in this group (matches while searching), collapsed or not */
  memberIds: string[]
}

export interface CanvasGroupRowItem<T> {
  kind: 'row'
  section: T
}

export type CanvasGroupedItem<T> = CanvasGroupHeaderItem | CanvasGroupRowItem<T>

export interface CanvasGroupedList<T> {
  /** Render order: rows and group headers */
  items: CanvasGroupedItem<T>[]
  /** Every row in visual order, rows of collapsed groups too */
  allRows: T[]
  /** Rows the user can see and navigate to */
  visibleRows: T[]
}

/**
 * Canvas list in grouped mode. Order: pending rows, base session, each group
 * (by `order`) with its rows sorted by row state, then Ungrouped. Collapsed
 * groups emit only their header. While searching, groups with no matches are
 * hidden and groups with matches show expanded (saved collapse is kept). On a
 * non-`all` tab, empty groups are hidden; on `all`, every group shows.
 */
export function buildCanvasGroupedList<T extends CanvasSectionLike>({
  sections,
  groups,
  projectId,
  collapsedKeys,
  hasSearchQuery,
  activeFilterTab,
  getRowState,
}: {
  /** Sort-mode ordered sections (search and tab already applied) */
  sections: readonly T[]
  groups: readonly WorktreeGroup[]
  projectId: string
  collapsedKeys: ReadonlySet<string>
  hasSearchQuery: boolean
  activeFilterTab: string
  getRowState: (section: T) => CanvasRowState
}): CanvasGroupedList<T> {
  const sectionById = new Map(sections.map(s => [s.worktree.id, s]))
  const toSections = (worktrees: readonly Worktree[]) =>
    worktrees.flatMap(w => {
      const section = sectionById.get(w.id)
      return section ? [section] : []
    })
  // Pending sections come first in the input; keep them there (the helper
  // would also bucket them, but keep the canvas order explicit).
  const pending = sections.filter(s => s.isPending)
  const grouped = groupWorktrees(
    sections.filter(s => !s.isPending).map(s => s.worktree),
    groups
  )

  const items: CanvasGroupedItem<T>[] = []
  const allRows: T[] = []
  const visibleRows: T[] = []
  const pushRow = (section: T, visible: boolean) => {
    allRows.push(section)
    if (!visible) return
    visibleRows.push(section)
    items.push({ kind: 'row', section })
  }

  for (const section of pending) pushRow(section, true)
  const base = grouped.base ? sectionById.get(grouped.base.id) : undefined
  if (base) pushRow(base, true)

  const hideEmpty = hasSearchQuery || activeFilterTab !== 'all'
  const buckets: { group: WorktreeGroup | null; worktrees: Worktree[] }[] = [
    ...grouped.groups,
    { group: null, worktrees: grouped.ungrouped },
  ]
  for (const bucket of buckets) {
    const rows = sortByCanvasRowState(toSections(bucket.worktrees), getRowState)
    if (rows.length === 0 && hideEmpty) continue
    const collapseKey = worktreeGroupCollapseKey(
      projectId,
      bucket.group?.id ?? null
    )
    const isCollapsed = !hasSearchQuery && collapsedKeys.has(collapseKey)
    items.push({
      kind: 'header',
      group: bucket.group,
      collapseKey,
      isCollapsed,
      memberIds: rows.map(row => row.worktree.id),
    })
    for (const row of rows) pushRow(row, !isCollapsed)
  }

  return { items, allRows, visibleRows }
}

/**
 * Where the selection goes when the selected row is hidden: the next visible
 * row in the full visual order, else the previous one. Null when the target is
 * unknown or nothing is visible.
 */
export function nearestVisibleWorktreeId(
  allIds: readonly string[],
  visibleIds: ReadonlySet<string>,
  targetId: string
): string | null {
  const index = allIds.indexOf(targetId)
  if (index === -1) return null
  for (let i = index + 1; i < allIds.length; i++) {
    const id = allIds[i]
    if (id && visibleIds.has(id)) return id
  }
  for (let i = index - 1; i >= 0; i--) {
    const id = allIds[i]
    if (id && visibleIds.has(id)) return id
  }
  return null
}

/**
 * Keyboard move target in grouped mode: the visible neighbour in `direction`,
 * only when it is in the same group and has the same row state.
 */
export function findGroupedKeyboardMoveTarget({
  visibleIds,
  activeId,
  direction,
  worktreesById,
  groups,
  rowStateById,
}: {
  visibleIds: readonly string[]
  activeId: string
  direction: -1 | 1
  worktreesById: ReadonlyMap<string, Worktree>
  groups: readonly WorktreeGroup[]
  rowStateById: ReadonlyMap<string, CanvasRowState>
}): string | null {
  const index = visibleIds.indexOf(activeId)
  if (index === -1) return null
  const targetId = visibleIds[index + direction]
  if (!targetId) return null
  const active = worktreesById.get(activeId)
  const target = worktreesById.get(targetId)
  if (!active || !target) return null
  if (effectiveGroupId(active, groups) !== effectiveGroupId(target, groups)) {
    return null
  }
  if (rowStateById.get(activeId) !== rowStateById.get(targetId)) return null
  return targetId
}
