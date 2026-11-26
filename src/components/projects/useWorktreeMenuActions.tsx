import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isBaseSession,
  type Worktree,
  type WorktreeGroup,
} from '@/types/projects'
import {
  projectsQueryKeys,
  useArchiveWorktree,
  useMoveWorktreeToGroup,
  useDeleteWorktree,
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInEditor,
  useProjects,
  useRunScripts,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useSessions } from '@/services/chat'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  canGroupWorktree,
  effectiveGroupId,
  orderForMoveToGroupEnd,
  persistedWorktreeOrder,
} from '@/lib/worktree-groups'
import { useWorktreeGroupsSupported } from '@/lib/worktree-groups-level'
import { useCreateWorktreeGroupAndRename } from './useCreateWorktreeGroupAndRename'

const NO_GROUPS: readonly WorktreeGroup[] = []

interface UseWorktreeMenuActionsProps {
  worktree: Worktree
  projectId: string
}

export function useWorktreeMenuActions({
  worktree,
  projectId,
}: UseWorktreeMenuActionsProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const deleteWorktree = useDeleteWorktree()
  const archiveWorktree = useArchiveWorktree()
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const { data: runScripts = [] } = useRunScripts(worktree.path)
  const { data: preferences } = usePreferences()
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)
  const { data: projects } = useProjects()
  const isBase = isBaseSession(worktree)
  const project = projects?.find(p => p.id === projectId)
  const planQueueEnabled = Boolean(project?.plan_queue_settings?.enabled)

  // Worktree groups ("Move to group" submenu)
  const queryClient = useQueryClient()
  const moveToGroup = useMoveWorktreeToGroup()
  const createGroupAndRename = useCreateWorktreeGroupAndRename()
  const groupsSupported = useWorktreeGroupsSupported(
    project?.serverId ?? worktree.serverId
  )
  const groups = project?.worktree_groups ?? NO_GROUPS
  const canMoveToGroup = groupsSupported && canGroupWorktree(worktree)
  const currentGroupId = effectiveGroupId(worktree, groups)

  const moveWorktreeToGroup = useCallback(
    (groupId: string | null, knownGroups: readonly WorktreeGroup[]) => {
      // Manual order: land at the end of the target group (full order).
      // Other sort modes: position follows the sort.
      const sortMode =
        useProjectsStore.getState().projectCanvasSettings[projectId]
          ?.worktreeSortMode ?? 'created'
      let worktreeIds: string[] | undefined
      if (sortMode === 'manual') {
        const cached =
          queryClient.getQueryData<Worktree[]>(
            projectsQueryKeys.worktrees(projectId)
          ) ?? []
        worktreeIds = orderForMoveToGroupEnd(
          persistedWorktreeOrder(cached),
          new Map(cached.map(w => [w.id, w])),
          worktree.id,
          groupId,
          knownGroups
        )
      }
      moveToGroup.mutate({
        projectId,
        worktreeId: worktree.id,
        groupId,
        ...(worktreeIds ? { worktreeIds } : {}),
        switchToManualSort: false,
      })
    },
    [moveToGroup, projectId, queryClient, worktree.id]
  )

  const handleMoveToGroup = useCallback(
    (groupId: string | null) => moveWorktreeToGroup(groupId, groups),
    [groups, moveWorktreeToGroup]
  )

  const handleMoveToNewGroup = useCallback(async () => {
    const group = await createGroupAndRename(projectId)
    if (group) moveWorktreeToGroup(group.id, [...groups, group])
  }, [createGroupAndRename, groups, moveWorktreeToGroup, projectId])

  const hasMessages = sessionsData?.sessions?.some(
    session => session.messages.length > 0
  )

  const handleRun = useCallback(() => {
    const first = runScripts[0]
    if (first) {
      useTerminalStore.getState().startRun(worktree.id, first)
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
    }
  }, [runScripts, worktree.id])

  const handleRunCommand = useCallback(
    (cmd: string) => {
      useTerminalStore.getState().startRun(worktree.id, cmd)
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
    },
    [worktree.id]
  )

  const handleOpenPlanQueue = useCallback(() => {
    useUIStore.getState().setPlanQueueTarget({
      id: worktree.id,
      path: worktree.path,
      project_id: worktree.project_id,
      name: worktree.name,
    })
  }, [worktree.id, worktree.path, worktree.project_id, worktree.name])

  const handleOpenTerminalPanel = useCallback(() => {
    useTerminalStore.getState().addTerminal(worktree.id)
  }, [worktree.id])

  const handleOpenInFinder = useCallback(() => {
    openInFinder.mutate(worktree.path)
  }, [openInFinder, worktree.path])

  const handleOpenInTerminal = useCallback(() => {
    openInTerminal.mutate({
      worktreePath: worktree.path,
      terminal: preferences?.terminal,
    })
  }, [openInTerminal, worktree.path, preferences?.terminal])

  const handleOpenInEditor = useCallback(() => {
    openInEditor.mutate({
      worktreePath: worktree.path,
      editor: preferences?.editor,
    })
  }, [openInEditor, worktree.path, preferences?.editor])

  // The base session is permanent: it never closes.
  const handleClose = useCallback(() => {
    if (isBase) return
    deleteWorktree.mutate({ worktreeId: worktree.id, projectId })
  }, [isBase, deleteWorktree, worktree.id, projectId])

  const handleArchive = useCallback(() => {
    if (isBase) return
    archiveWorktree.mutate({ worktreeId: worktree.id, projectId })
  }, [isBase, archiveWorktree, worktree.id, projectId])

  const handleDelete = useCallback(
    (skipTeardown = false) => {
      deleteWorktree.mutate({
        worktreeId: worktree.id,
        projectId,
        skipTeardown,
      })
      setShowDeleteConfirm(false)
    },
    [deleteWorktree, worktree.id, projectId]
  )

  return {
    // State
    worktree,
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    hasMessages,
    runScripts,
    preferences,
    planQueueEnabled,
    groups,
    canMoveToGroup,
    currentGroupId,

    // Handlers
    handleMoveToGroup,
    handleMoveToNewGroup,
    handleRun,
    handleRunCommand,
    handleOpenPlanQueue,
    handleOpenTerminalPanel,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleClose,
    handleArchive,
    handleDelete,
  }
}
