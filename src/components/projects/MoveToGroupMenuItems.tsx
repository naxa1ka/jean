import { Check, Folder, FolderPlus } from '@/components/icons/reicon'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import type { WorktreeGroup } from '@/types/projects'

interface MoveToGroupMenuItemsProps {
  groups: readonly WorktreeGroup[]
  /** The worktree's effective group (null = ungrouped) */
  currentGroupId: string | null
  onMove: (groupId: string | null) => void
  onMoveToNewGroup: () => void
}

/** "Move to group ▸" submenu for a worktree context menu. */
export function MoveToGroupMenuItems({
  groups,
  currentGroupId,
  onMove,
  onMoveToNewGroup,
}: MoveToGroupMenuItemsProps) {
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order)
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Folder className="mr-2 h-4 w-4" />
        Move to group
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-48">
        {sortedGroups.map(group => {
          const isCurrent = group.id === currentGroupId
          return (
            <ContextMenuItem
              key={group.id}
              disabled={isCurrent}
              onSelect={() => onMove(group.id)}
            >
              {isCurrent ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <span className="mr-2 h-4 w-4" />
              )}
              <span className="truncate">{group.name}</span>
            </ContextMenuItem>
          )
        })}
        {currentGroupId !== null && (
          <ContextMenuItem onSelect={() => onMove(null)}>
            <span className="mr-2 h-4 w-4" />
            No group
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onMoveToNewGroup}>
          <FolderPlus className="mr-2 h-4 w-4" />
          New group…
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
