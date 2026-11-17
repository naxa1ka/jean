import { queryClient } from '@/lib/query-client'
import { invoke, invokeForServer } from '@/lib/transport'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences, MarkDefinition } from '@/types/preferences'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

async function writeMarkDefinitions(
  command: 'set_mark_definitions' | 'merge_mark_definitions',
  serverId: string | undefined,
  definitions: MarkDefinition[]
): Promise<MarkDefinition[]> {
  const owner = serverId ?? LOCAL_SERVER_ID
  const args = { definitions }
  const list =
    owner === LOCAL_SERVER_ID
      ? await invoke<MarkDefinition[]>(command, args)
      : await invokeForServer<MarkDefinition[]>(owner, command, args)
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
