import { isLocalBackend } from '@/lib/environment'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { useServerCapabilities } from '@/services/server-capabilities'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Marks support level of this client build. The local core always matches it. */
export const CLIENT_MARKS_LEVEL = 1

export interface MarksLevelInput {
  /** Owning server of the resource; `undefined` or `local` means the current transport. */
  serverId?: string
  /** True when the current transport is this desktop app's own Jean core. */
  isLocalBackend: boolean
  /** Capabilities of the current transport's server (Web Access or remote transport). */
  transportCapabilities?: Readonly<Record<string, number>>
  /** Capabilities of the remote server named by `serverId`. */
  remoteCapabilities?: Readonly<Record<string, number>>
}

/** Marks level a server supports. Unknown or old servers report 0. */
export function getMarksLevel({
  serverId,
  isLocalBackend,
  transportCapabilities,
  remoteCapabilities,
}: MarksLevelInput): number {
  if (serverId === undefined || serverId === LOCAL_SERVER_ID) {
    if (isLocalBackend) return CLIENT_MARKS_LEVEL
    return transportCapabilities?.marks ?? 0
  }
  return remoteCapabilities?.marks ?? 0
}

/** Marks level of the server that owns a resource (current transport when no id). */
export function useServerMarksLevel(serverId?: string): number {
  const { data } = useServerCapabilities()
  const snapshots = useServerConnectionSnapshots()
  return getMarksLevel({
    serverId,
    isLocalBackend: isLocalBackend(),
    transportCapabilities: data?.capabilities,
    remoteCapabilities: serverId
      ? snapshots.get(serverId)?.capabilities
      : undefined,
  })
}
