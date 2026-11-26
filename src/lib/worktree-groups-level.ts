import { isLocalBackend } from '@/lib/environment'
import type { MarksLevelInput } from '@/lib/marks-level'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { useServerCapabilities } from '@/services/server-capabilities'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Worktree groups support level of this client build. The local core always matches it. */
export const CLIENT_WORKTREE_GROUPS_LEVEL = 1

/** Worktree groups level a server supports. Unknown or old servers report 0. */
export function getWorktreeGroupsLevel({
  serverId,
  isLocalBackend,
  transportCapabilities,
  remoteCapabilities,
}: MarksLevelInput): number {
  if (serverId === undefined || serverId === LOCAL_SERVER_ID) {
    if (isLocalBackend) return CLIENT_WORKTREE_GROUPS_LEVEL
    return transportCapabilities?.worktreeGroups ?? 0
  }
  return remoteCapabilities?.worktreeGroups ?? 0
}

/** Whether the server that owns a project (current transport when no id) supports worktree groups. */
export function useWorktreeGroupsSupported(serverId?: string): boolean {
  const { data } = useServerCapabilities()
  const snapshots = useServerConnectionSnapshots()
  return (
    getWorktreeGroupsLevel({
      serverId,
      isLocalBackend: isLocalBackend(),
      transportCapabilities: data?.capabilities,
      remoteCapabilities: serverId
        ? snapshots.get(serverId)?.capabilities
        : undefined,
    }) >= 1
  )
}
