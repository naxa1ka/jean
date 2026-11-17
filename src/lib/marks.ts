import { useQueries } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useMarksLevelLookup, useServerMarksLevel } from '@/lib/marks-level'
import {
  loadPreferencesForServer,
  preferencesQueryKeys,
  usePreferences,
} from '@/services/preferences'
import type { LabelData } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Marks level from which a server has the managed mark list. */
export const MARK_LIST_LEVEL = 2

/** Marks level from which a server renames and removes a mark on all its items. */
export const MARK_EVERYWHERE_LEVEL = 3

/** Marks level from which a server lists tracked items and clears them (bell). */
export const TRACKED_MARKS_LEVEL = 4

/** Stable empty list for servers without a mark list. */
export const NO_MARK_DEFINITIONS: MarkDefinition[] = []

/** A mark as shown in the UI: the definition values when the list has it. */
export interface ResolvedMark {
  name: string
  color: string
  icon: string | null
  tracked: boolean
  /** True when the server mark list has no definition with this name. */
  orphan: boolean
}

/** Definition with the same name (case-insensitive), if any. */
export function findDefinition(
  name: string,
  definitions: readonly MarkDefinition[]
): MarkDefinition | undefined {
  const key = name.toLowerCase()
  return definitions.find(definition => definition.name.toLowerCase() === key)
}

/** Display values of an applied mark. The definition wins over the item copy. */
export function resolveMark(
  label: LabelData,
  definitions: readonly MarkDefinition[]
): ResolvedMark {
  const definition = findDefinition(label.name, definitions)
  if (!definition) {
    return {
      name: label.name,
      color: label.color,
      icon: null,
      tracked: false,
      orphan: true,
    }
  }
  return {
    name: definition.name,
    color: definition.color,
    icon: definition.icon,
    tracked: definition.tracked,
    orphan: false,
  }
}

/**
 * Mark list of a server (`undefined` = the current transport's server).
 * Empty below marks level 2, because older servers have no managed list.
 */
export function useMarkDefinitions(serverId?: string): MarkDefinition[] {
  const level = useServerMarksLevel(serverId)
  const { data } = usePreferences(serverId ?? LOCAL_SERVER_ID)
  if (level < MARK_LIST_LEVEL) return NO_MARK_DEFINITIONS
  return data?.mark_definitions ?? NO_MARK_DEFINITIONS
}

function combineDefinitionLists(
  results: { data?: { mark_definitions?: MarkDefinition[] } }[]
): (MarkDefinition[] | undefined)[] {
  return results.map(result => result.data?.mark_definitions)
}

/**
 * Mark lists of many servers, for views that list items of all servers (the
 * bell). Returns a lookup by server id (`undefined` = the current transport).
 * Shares the preferences query cache with `usePreferences`.
 */
export function useMarkDefinitionsByServer(
  serverIds: readonly string[]
): (serverId?: string) => MarkDefinition[] {
  const marksLevel = useMarksLevelLookup()
  const lists = useQueries({
    queries: serverIds.map(serverId => ({
      queryKey: preferencesQueryKeys.preferences(serverId),
      queryFn: () => loadPreferencesForServer(serverId),
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 10,
    })),
    combine: combineDefinitionLists,
  })
  // Pass a memoized `serverIds`, so the lookup stays stable between renders.
  return useCallback(
    (serverId?: string) => {
      const id = serverId ?? LOCAL_SERVER_ID
      if (marksLevel(id) < MARK_LIST_LEVEL) return NO_MARK_DEFINITIONS
      return lists[serverIds.indexOf(id)] ?? NO_MARK_DEFINITIONS
    },
    [lists, serverIds, marksLevel]
  )
}

/** First tracked definition in list order (the "Review later" target), if any. */
export function firstTrackedDefinition(
  definitions: readonly MarkDefinition[]
): MarkDefinition | undefined {
  return definitions.find(definition => definition.tracked)
}
