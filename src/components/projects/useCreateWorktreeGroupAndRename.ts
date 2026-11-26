import { useCallback } from 'react'
import { useCreateWorktreeGroup } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import type { WorktreeGroup } from '@/types/projects'

export const NEW_WORKTREE_GROUP_NAME = 'New group'

/**
 * Create a "New group" in a project, expand the project and start the inline
 * rename. Resolves to null when the create fails (the hook shows the toast).
 */
export function useCreateWorktreeGroupAndRename() {
  const { mutateAsync } = useCreateWorktreeGroup()

  return useCallback(
    async (projectId: string): Promise<WorktreeGroup | null> => {
      try {
        const group = await mutateAsync({
          projectId,
          name: NEW_WORKTREE_GROUP_NAME,
        })
        const store = useProjectsStore.getState()
        store.expandProject(projectId)
        store.setWorktreeGroupCollapsed(group.id, false)
        store.setEditingWorktreeGroupId(group.id)
        return group
      } catch {
        return null
      }
    },
    [mutateAsync]
  )
}
