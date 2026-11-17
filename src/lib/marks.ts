import { useServerMarksLevel } from '@/lib/marks-level'
import { usePreferences } from '@/services/preferences'
import type { LabelData } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

/** Marks level from which a server has the managed mark list. */
export const MARK_LIST_LEVEL = 2

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
