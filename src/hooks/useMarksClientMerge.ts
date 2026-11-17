import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isLocalBackend } from '@/lib/environment'
import { logger } from '@/lib/logger'
import { getMarksLevel } from '@/lib/marks-level'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import { parseServerResourceKey } from '@/lib/server-resource'
import { invoke, invokeForServer } from '@/lib/transport'
import { preferencesQueryKeys } from '@/services/preferences'
import { useServerCapabilities } from '@/services/server-capabilities'
import { useProjectsStore } from '@/store/projects-store'
import type { LabelData } from '@/types/chat'
import type { AppPreferences, MarkDefinition } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Marks level from which a server has the managed mark list. */
const MARK_LIST_LEVEL = 2
const MERGED_FLAG_PREFIX = 'jean-marks-merged:'

export function marksMergedFlagKey(serverId: string): string {
  return `${MERGED_FLAG_PREFIX}${serverId}`
}

interface CanvasLabelSettings {
  labels?: LabelData[]
  pinnedLabels?: LabelData[]
}

/**
 * Group the client's per-project labels and pins by owning server.
 * Raw project ids belong to the local server, `serverId:projectId` keys to that server.
 * The server dedupes names, so this keeps the input order and does not dedupe.
 */
export function groupClientMarksByServer(
  settings: Readonly<Record<string, CanvasLabelSettings | undefined>>
): Map<string, MarkDefinition[]> {
  const groups = new Map<string, MarkDefinition[]>()
  for (const [key, value] of Object.entries(settings)) {
    const labels = [...(value?.labels ?? []), ...(value?.pinnedLabels ?? [])]
    if (labels.length === 0) continue
    const serverId = parseServerResourceKey(key)?.serverId ?? LOCAL_SERVER_ID
    const group = groups.get(serverId) ?? []
    for (const label of labels) {
      group.push({
        name: label.name,
        color: label.color,
        icon: null,
        tracked: false,
      })
    }
    groups.set(serverId, group)
  }
  return groups
}

/**
 * One-time upgrade step: merge this client's local label registry and pins into
 * the mark list of each server, once per server (a localStorage flag).
 * Retries when a server connects or reports a new marks level.
 */
export function useMarksClientMerge(): void {
  const queryClient = useQueryClient()
  const snapshots = useServerConnectionSnapshots()
  const { data: transportCapabilities } = useServerCapabilities()
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    const run = () => {
      const groups = groupClientMarksByServer(
        useProjectsStore.getState().projectCanvasSettings
      )
      for (const [serverId, definitions] of groups) {
        if (inFlight.current.has(serverId)) continue
        if (localStorage.getItem(marksMergedFlagKey(serverId))) continue
        const isLocal = serverId === LOCAL_SERVER_ID
        const snapshot = isLocal ? undefined : snapshots.get(serverId)
        if (!isLocal && snapshot?.status !== 'online') continue
        const level = getMarksLevel({
          serverId,
          isLocalBackend: isLocalBackend(),
          transportCapabilities: transportCapabilities?.capabilities,
          remoteCapabilities: snapshot?.capabilities,
        })
        if (level < MARK_LIST_LEVEL) continue

        inFlight.current.add(serverId)
        const args = { definitions }
        const request = isLocal
          ? invoke<MarkDefinition[]>('merge_mark_definitions', args)
          : invokeForServer<MarkDefinition[]>(
              serverId,
              'merge_mark_definitions',
              args
            )
        request
          .then(list => {
            localStorage.setItem(marksMergedFlagKey(serverId), '1')
            queryClient.setQueryData<AppPreferences>(
              preferencesQueryKeys.preferences(serverId),
              old => (old ? { ...old, mark_definitions: list } : old)
            )
          })
          .catch(error => {
            logger.warn('Failed to merge local marks into server mark list', {
              serverId,
              error,
            })
          })
          .finally(() => {
            inFlight.current.delete(serverId)
          })
      }
    }

    run()
    // Labels arrive later (view-state restore, ui-state load); rerun on change
    // without re-rendering the app root.
    return useProjectsStore.subscribe((state, previous) => {
      if (state.projectCanvasSettings !== previous.projectCanvasSettings) run()
    })
  }, [queryClient, snapshots, transportCapabilities])
}
