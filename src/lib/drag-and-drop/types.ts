export const DRAG_TYPE_WORKTREE = 'worktree-section'
/** Drag data of a group header (group reorder). */
export const DRAG_TYPE_WORKTREE_GROUP = 'worktree-group'
/** Drop target data of a group header (worktree "into group", group reorder). */
export const DROP_TYPE_WORKTREE_GROUP_HEADER = 'worktree-group-header'
/** `groupId` of the Ungrouped header (drop target only). */
export const UNGROUPED_GROUP_ID = 'ungrouped'
export const DRAG_TYPE_PROJECT_TREE_ITEM = 'project-tree-item'
export const DRAG_SCOPE_WORKTREE_LIST = 'worktree-list'
export const DRAG_SCOPE_CANVAS_WORKTREE_LIST = 'canvas-worktree-list'
export const ROOT_DROP_TARGET_ID = 'root-drop-zone'

export interface WorktreeDragData extends Record<string, unknown> {
  type: typeof DRAG_TYPE_WORKTREE
  projectId: string
  worktreeId: string
  scope:
    | typeof DRAG_SCOPE_WORKTREE_LIST
    | typeof DRAG_SCOPE_CANVAS_WORKTREE_LIST
}

export interface WorktreeDropTargetData extends Record<string, unknown> {
  [key: symbol]: unknown
  type: typeof DRAG_TYPE_WORKTREE
  projectId: string
  worktreeId: string
  scope:
    | typeof DRAG_SCOPE_WORKTREE_LIST
    | typeof DRAG_SCOPE_CANVAS_WORKTREE_LIST
}

type WorktreeListScope =
  | typeof DRAG_SCOPE_WORKTREE_LIST
  | typeof DRAG_SCOPE_CANVAS_WORKTREE_LIST

export interface WorktreeGroupDragData extends Record<string, unknown> {
  type: typeof DRAG_TYPE_WORKTREE_GROUP
  projectId: string
  groupId: string
  scope: WorktreeListScope
}

export interface WorktreeGroupHeaderDropTargetData extends Record<
  string,
  unknown
> {
  [key: symbol]: unknown
  type: typeof DROP_TYPE_WORKTREE_GROUP_HEADER
  projectId: string
  /** Group UUID, or `UNGROUPED_GROUP_ID` */
  groupId: string
  scope: WorktreeListScope
}

export interface ProjectTreeDragData extends Record<string, unknown> {
  type: typeof DRAG_TYPE_PROJECT_TREE_ITEM
  itemId: string
}

export interface ProjectTreeItemDropTargetData extends Record<string, unknown> {
  [key: symbol]: unknown
  type: typeof DRAG_TYPE_PROJECT_TREE_ITEM
  targetId: string
}

export interface ProjectTreeRootDropTargetData extends Record<string, unknown> {
  [key: symbol]: unknown
  type: typeof DRAG_TYPE_PROJECT_TREE_ITEM
  targetId: typeof ROOT_DROP_TARGET_ID
  root: true
}

export type ProjectTreeDropTargetData =
  | ProjectTreeItemDropTargetData
  | ProjectTreeRootDropTargetData

export function isWorktreeDragData(
  data: Record<string, unknown>
): data is WorktreeDragData {
  return (
    data.type === DRAG_TYPE_WORKTREE &&
    typeof data.worktreeId === 'string' &&
    (data.scope === DRAG_SCOPE_WORKTREE_LIST ||
      data.scope === DRAG_SCOPE_CANVAS_WORKTREE_LIST)
  )
}

export function isWorktreeDropTargetData(
  data: Record<string | symbol, unknown>
): data is WorktreeDropTargetData {
  return (
    data.type === DRAG_TYPE_WORKTREE &&
    typeof data.worktreeId === 'string' &&
    (data.scope === DRAG_SCOPE_WORKTREE_LIST ||
      data.scope === DRAG_SCOPE_CANVAS_WORKTREE_LIST)
  )
}

export function isProjectTreeDragData(
  data: Record<string, unknown>
): data is ProjectTreeDragData {
  return (
    data.type === DRAG_TYPE_PROJECT_TREE_ITEM && typeof data.itemId === 'string'
  )
}

export function isProjectTreeDropTargetData(
  data: Record<string | symbol, unknown>
): data is ProjectTreeDropTargetData {
  return (
    data.type === DRAG_TYPE_PROJECT_TREE_ITEM &&
    typeof data.targetId === 'string'
  )
}

function isWorktreeListScope(scope: unknown): scope is WorktreeListScope {
  return (
    scope === DRAG_SCOPE_WORKTREE_LIST ||
    scope === DRAG_SCOPE_CANVAS_WORKTREE_LIST
  )
}

export function isWorktreeGroupDragData(
  data: Record<string, unknown>
): data is WorktreeGroupDragData {
  return (
    data.type === DRAG_TYPE_WORKTREE_GROUP &&
    typeof data.projectId === 'string' &&
    typeof data.groupId === 'string' &&
    isWorktreeListScope(data.scope)
  )
}

export function isWorktreeGroupHeaderDropTargetData(
  data: Record<string | symbol, unknown>
): data is WorktreeGroupHeaderDropTargetData {
  return (
    data.type === DROP_TYPE_WORKTREE_GROUP_HEADER &&
    typeof data.projectId === 'string' &&
    typeof data.groupId === 'string' &&
    isWorktreeListScope(data.scope)
  )
}
