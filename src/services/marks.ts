import { queryClient } from '@/lib/query-client'
import { parseServerResourceKey } from '@/lib/server-resource'
import { invoke, invokeForServer } from '@/lib/transport'
import { chatQueryKeys } from '@/services/chat'
import { preferencesQueryKeys } from '@/services/preferences'
import { projectsQueryKeys } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import type { LabelData } from '@/types/chat'
import type { AppPreferences, MarkDefinition } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

async function writeMarkDefinitions(
  command: 'set_mark_definitions' | 'merge_mark_definitions',
  serverId: string | undefined,
  definitions: MarkDefinition[]
): Promise<MarkDefinition[]> {
  const owner = serverId ?? LOCAL_SERVER_ID
  const list = await callMarksCommand<MarkDefinition[]>(owner, command, {
    definitions,
  })
  queryClient.setQueryData<AppPreferences>(
    preferencesQueryKeys.preferences(owner),
    old => (old ? { ...old, mark_definitions: list } : old)
  )
  return list
}

/** Replace a server's mark list (strict validation on the server). */
export function setMarkDefinitions(
  serverId: string | undefined,
  definitions: MarkDefinition[]
): Promise<MarkDefinition[]> {
  return writeMarkDefinitions('set_mark_definitions', serverId, definitions)
}

/** Add new names to a server's mark list. Known names keep their values. */
export function mergeMarkDefinitions(
  serverId: string | undefined,
  definitions: MarkDefinition[]
): Promise<MarkDefinition[]> {
  return writeMarkDefinitions('merge_mark_definitions', serverId, definitions)
}

/** How many items use a mark (count), or were changed (rename/remove). */
export interface MarkUsage {
  worktrees: number
  sessions: number
}

function callMarksCommand<T>(
  serverId: string | undefined,
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  const owner = serverId ?? LOCAL_SERVER_ID
  return owner === LOCAL_SERVER_ID
    ? invoke<T>(command, args)
    : invokeForServer<T>(owner, command, args)
}

/** Live worktrees and sessions of a server that have the mark `name`. */
export function countMarkUsage(
  serverId: string | undefined,
  name: string
): Promise<MarkUsage> {
  return callMarksCommand(serverId, 'count_mark_usage', { name })
}

/**
 * Change this client's project pins of one server. Raw project ids belong to
 * the local server, `serverId:projectId` keys to that server. The normal
 * UI-state save writes the change; the server never writes these pins.
 */
function updateServerPins(
  serverId: string | undefined,
  update: (pins: LabelData[]) => LabelData[]
) {
  const owner = serverId ?? LOCAL_SERVER_ID
  const { projectCanvasSettings, setProjectCanvasPinnedLabels } =
    useProjectsStore.getState()
  for (const [projectKey, settings] of Object.entries(projectCanvasSettings)) {
    const keyServer =
      parseServerResourceKey(projectKey)?.serverId ?? LOCAL_SERVER_ID
    if (keyServer !== owner || !settings.pinnedLabels?.length) continue
    setProjectCanvasPinnedLabels(projectKey, update(settings.pinnedLabels))
  }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Marked items changed on the server: refetch sessions and worktrees. */
function invalidateMarkedItems() {
  queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
  queryClient.invalidateQueries({ queryKey: chatQueryKeys.all })
  queryClient.invalidateQueries({ queryKey: projectsQueryKeys.all })
  queryClient.invalidateQueries({ queryKey: ['multi-server'] })
}

function refetchPreferences(serverId: string | undefined) {
  queryClient.invalidateQueries({
    queryKey: preferencesQueryKeys.preferences(serverId ?? LOCAL_SERVER_ID),
  })
}

/** Rename a mark in the list and on every item of the server, then in this client's pins. */
export async function renameMark(
  serverId: string | undefined,
  oldName: string,
  newName: string
): Promise<MarkUsage> {
  const usage = await callMarksCommand<MarkUsage>(serverId, 'rename_mark', {
    oldName,
    newName,
  })
  const name = newName.trim()
  updateServerPins(serverId, pins => {
    const renamed = pins.map(pin =>
      sameName(pin.name, oldName) ? { ...pin, name } : pin
    )
    return renamed.filter(
      (pin, index) =>
        renamed.findIndex(other => sameName(other.name, pin.name)) === index
    )
  })
  refetchPreferences(serverId)
  invalidateMarkedItems()
  return usage
}

/** Remove a mark from the list and from every item of the server, then from this client's pins. */
export async function removeMarkEverywhere(
  serverId: string | undefined,
  name: string
): Promise<MarkUsage> {
  const usage = await callMarksCommand<MarkUsage>(
    serverId,
    'remove_mark_everywhere',
    { name }
  )
  updateServerPins(serverId, pins =>
    pins.filter(pin => !sameName(pin.name, name))
  )
  refetchPreferences(serverId)
  invalidateMarkedItems()
  return usage
}
