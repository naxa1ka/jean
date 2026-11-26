import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  effectiveGroupId,
  worktreeGroupCollapseKey,
} from '@/lib/worktree-groups'
import { projectsQueryKeys } from '@/services/projects'
import type { MultiServerProject } from '@/services/multi-server-projects'
import { useProjectsStore } from '@/store/projects-store'
import {
  isBaseSession,
  type Project,
  type Worktree,
  type WorktreeGroup,
} from '@/types/projects'

const WORKTREES_QUERY_PREFIX = [...projectsQueryKeys.all, 'worktrees'] as const
const MULTI_SERVER_PROJECTS_KEY = ['multi-server', 'projects'] as const

/** Groups of a project from the project list caches (local id or multi-server key). */
function cachedProjectGroups(
  queryClient: QueryClient,
  projectId: string
): readonly WorktreeGroup[] {
  const local = queryClient
    .getQueryData<Project[]>(projectsQueryKeys.list())
    ?.find(p => p.id === projectId)
  if (local) return local.worktree_groups ?? []
  for (const [, projects] of queryClient.getQueriesData<MultiServerProject[]>({
    queryKey: MULTI_SERVER_PROJECTS_KEY,
  })) {
    const remote = projects?.find(p => p.key === projectId)
    if (remote) return remote.worktree_groups ?? []
  }
  return []
}

/** Expand the sidebar group that holds a worktree, when that group is collapsed. */
export function revealWorktreeGroup(
  queryClient: QueryClient,
  worktreeId: string
): void {
  for (const [queryKey, worktrees] of queryClient.getQueriesData<Worktree[]>({
    queryKey: WORKTREES_QUERY_PREFIX,
  })) {
    const worktree = worktrees?.find(w => w.id === worktreeId)
    const projectId = queryKey[2]
    if (!worktree || typeof projectId !== 'string') continue
    // Base and pending rows show outside the groups.
    if (isBaseSession(worktree) || worktree.status === 'pending') return
    const groups = cachedProjectGroups(queryClient, projectId)
    if (groups.length === 0) return
    useProjectsStore
      .getState()
      .setWorktreeGroupCollapsed(
        worktreeGroupCollapseKey(projectId, effectiveGroupId(worktree, groups)),
        false
      )
    return
  }
}

/**
 * When the selected worktree changes to one in a collapsed group, expand that
 * group. Starts after UI state restore, so a saved collapse stays on startup;
 * it never reacts to collapse changes themselves.
 */
export function useRevealSelectedWorktreeGroup(isInitialized: boolean): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!isInitialized) return
    return useProjectsStore.subscribe((state, previous) => {
      const worktreeId = state.selectedWorktreeId
      if (!worktreeId || worktreeId === previous.selectedWorktreeId) return
      revealWorktreeGroup(queryClient, worktreeId)
    })
  }, [isInitialized, queryClient])
}
