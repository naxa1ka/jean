import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { isNativeApp } from '@/lib/environment'
import { TRACKED_MARKS_LEVEL } from '@/lib/marks'
import { useMarksLevelLookup } from '@/lib/marks-level'
import { useRemoteConnections } from '@/lib/remote-connections'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { invoke, invokeForServer } from '@/lib/transport'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type { AllSessionsResponse, TrackedItemsResponse } from '@/types/chat'

export interface SessionServerSource {
  serverId: string
  name: string
  online: boolean
}

export async function loadAllSessionsForServers(
  sources: SessionServerSource[],
  invokeServer: (
    serverId: string,
    command: string
  ) => Promise<AllSessionsResponse>,
  command: 'list_all_sessions' | 'list_unread_sessions' = 'list_all_sessions'
): Promise<AllSessionsResponse> {
  const responses = await Promise.allSettled(
    sources
      .filter(source => source.online)
      .map(async source => ({
        source,
        response: await invokeServer(source.serverId, command),
      }))
  )

  return {
    entries: responses.flatMap(result =>
      result.status === 'fulfilled'
        ? result.value.response.entries.map(entry => ({
            ...entry,
            serverId: result.value.source.serverId,
            serverName: result.value.source.name,
          }))
        : []
    ),
  }
}

/** Tracked items of every online server, each tagged with its server. */
export async function loadTrackedItemsForServers(
  sources: SessionServerSource[],
  invokeServer: (serverId: string) => Promise<TrackedItemsResponse>
): Promise<TrackedItemsResponse> {
  const responses = await Promise.allSettled(
    sources
      .filter(source => source.online)
      .map(async source => ({
        source,
        response: await invokeServer(source.serverId),
      }))
  )

  return {
    entries: responses
      .flatMap(result =>
        result.status === 'fulfilled'
          ? result.value.response.entries.map(entry => ({
              ...entry,
              serverId: result.value.source.serverId,
              serverName: result.value.source.name,
            }))
          : []
      )
      // Newest mark first across servers; items without a date go last.
      .sort((a, b) => (b.added_at ?? -1) - (a.added_at ?? -1)),
  }
}

export async function loadUnreadSessionCountForServers(
  sources: SessionServerSource[],
  invokeServer: (serverId: string, command: string) => Promise<number>
): Promise<number> {
  const counts = await Promise.all(
    sources
      .filter(source => source.online)
      .map(source => invokeServer(source.serverId, 'get_unread_session_count'))
  )
  return counts.reduce((total, count) => total + count, 0)
}

export function useSessionServerSources(): SessionServerSource[] {
  const native = isNativeApp()
  const connections = useRemoteConnections()
  const snapshots = useServerConnectionSnapshots()
  return native
    ? [
        { serverId: LOCAL_SERVER_ID, name: 'Local', online: true },
        ...connections
          .filter(connection => connection.enabled !== false)
          .map(connection => ({
            serverId: connection.id,
            name: connection.name,
            online: snapshots.get(connection.id)?.status === 'online',
          })),
      ]
    : [{ serverId: LOCAL_SERVER_ID, name: 'This server', online: true }]
}

export function useConsolidatedAllSessions(enabled = true) {
  const native = isNativeApp()
  const sources = useSessionServerSources()
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  // The server set is part of the key, so a server that comes online or goes
  // away starts a new fetch.
  return useQuery({
    queryKey: ['all-sessions', sourceKey],
    queryFn: () =>
      native
        ? loadAllSessionsForServers(sources, (serverId, command) =>
            invokeForServer<AllSessionsResponse>(serverId, command)
          )
        : invoke<AllSessionsResponse>('list_all_sessions'),
    enabled,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchInterval: native ? 60_000 : false,
    placeholderData: keepPreviousData,
  })
}

/**
 * Unread sessions only, for the finished-session popover. Lives under the
 * ['all-sessions'] prefix so every existing invalidation also refreshes it.
 */
export function useConsolidatedUnreadSessions(enabled = true) {
  const native = isNativeApp()
  const sources = useSessionServerSources()
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  return useQuery({
    queryKey: ['all-sessions', 'unread', sourceKey],
    queryFn: () =>
      native
        ? loadAllSessionsForServers(
            sources,
            (serverId, command) =>
              invokeForServer<AllSessionsResponse>(serverId, command),
            'list_unread_sessions'
          )
        : invoke<AllSessionsResponse>('list_unread_sessions'),
    enabled,
    // The bell refetches on open and on count changes; cached rows render
    // while the fetch runs.
    staleTime: 0,
    gcTime: 120_000,
  })
}

export function useConsolidatedUnreadSessionCount() {
  const native = isNativeApp()
  const sources = useSessionServerSources()
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  return useQuery({
    queryKey: ['unread-session-count', sourceKey],
    queryFn: () =>
      native
        ? loadUnreadSessionCountForServers(sources, (serverId, command) =>
            invokeForServer<number>(serverId, command)
          )
        : invoke<number>('get_unread_session_count'),
    staleTime: 60_000,
    gcTime: 120_000,
    refetchInterval: native ? 60_000 : false,
  })
}

/** Session sources whose server lists tracked items (marks level >= 4). */
export function useTrackedServerSources(): SessionServerSource[] {
  const sources = useSessionServerSources()
  const marksLevel = useMarksLevelLookup()
  return sources.filter(
    source =>
      marksLevel(
        source.serverId === LOCAL_SERVER_ID ? undefined : source.serverId
      ) >= TRACKED_MARKS_LEVEL
  )
}

/**
 * Sessions and worktrees with tracked marks, for the bell "Tracked" tab. Lives
 * under the ['all-sessions'] prefix so session invalidations refresh it too.
 */
export function useConsolidatedTrackedItems(enabled = true) {
  const native = isNativeApp()
  const sources = useTrackedServerSources()
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  return useQuery({
    queryKey: ['all-sessions', 'tracked', sourceKey],
    queryFn: () =>
      native
        ? loadTrackedItemsForServers(sources, serverId =>
            invokeForServer<TrackedItemsResponse>(
              serverId,
              'list_tracked_items'
            )
          )
        : invoke<TrackedItemsResponse>('list_tracked_items'),
    enabled: enabled && sources.length > 0,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchInterval: native ? 60_000 : false,
    placeholderData: keepPreviousData,
  })
}
