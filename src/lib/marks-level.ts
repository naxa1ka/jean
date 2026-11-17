import { isLocalBackend } from '@/lib/environment'
import { queryClient } from '@/lib/query-client'
import {
  serverConnectionManager,
  useServerConnectionSnapshots,
} from '@/lib/server-connections'
import { parseServerResourceKey } from '@/lib/server-resource'
import {
  serverCapabilitiesQueryKey,
  useServerCapabilities,
} from '@/services/server-capabilities'
import type { ServerCapabilitiesEnvelope } from '@/types/server-capabilities'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Marks support level of this client build. The local core always matches it. */
export const CLIENT_MARKS_LEVEL = 3

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

/** Owning server of a resource key: the scope of `server:id`, else the current transport. */
export function getResourceServerId(resourceKey: string): string | undefined {
  const serverId = parseServerResourceKey(resourceKey)?.serverId
  return serverId && serverId !== LOCAL_SERVER_ID ? serverId : undefined
}

/** Non-hook marks level for the server that owns a (possibly scoped) resource id. */
export function getMarksLevelForResource(resourceKey: string): number {
  const serverId = getResourceServerId(resourceKey)
  return getMarksLevel({
    serverId,
    isLocalBackend: isLocalBackend(),
    transportCapabilities: queryClient.getQueryData<ServerCapabilitiesEnvelope>(
      serverCapabilitiesQueryKey
    )?.capabilities,
    remoteCapabilities: serverId
      ? serverConnectionManager.getSnapshot().get(serverId)?.capabilities
      : undefined,
  })
}
