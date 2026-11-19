import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { projectsQueryKeys } from '@/services/projects'
import { getWorktreeLabels, mergePinnedLabels } from '@/lib/worktree-labels'
import type { LabelData } from '@/types/chat'
import type { Worktree } from '@/types/projects'

interface UseWorktreeMarkPickerOptions {
  projectId: string
  /** Server that owns the worktree; the picker shows this server's mark list. */
  serverId?: string
  /** Project pinned marks, merged into the marks the picker starts with. */
  pinnedLabels?: LabelData[]
}

/**
 * State and save logic of the worktree mark picker (`LabelModal` with
 * `target="worktree"`), shared by the canvas and the sidebar. The caller
 * renders the modal with `modalProps` and adds its own extras (pin toggle,
 * `extraLabels`).
 */
export function useWorktreeMarkPicker({
  projectId,
  serverId,
  pinnedLabels,
}: UseWorktreeMarkPickerOptions) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<{
    worktreeId: string
    currentLabels: LabelData[]
  } | null>(null)

  const open = useCallback(
    (worktree: Worktree) => {
      const labels = getWorktreeLabels(worktree)
      setTarget({
        worktreeId: worktree.id,
        currentLabels: pinnedLabels
          ? mergePinnedLabels(labels, pinnedLabels)
          : labels,
      })
    },
    [pinnedLabels]
  )

  const close = useCallback(() => setTarget(null), [])

  const updateCurrentLabels = useCallback(
    (update: (labels: LabelData[]) => LabelData[]) =>
      setTarget(current =>
        current
          ? { ...current, currentLabels: update(current.currentLabels) }
          : current
      ),
    []
  )

  const worktreeId = target?.worktreeId
  const apply = useCallback(
    async (labels: LabelData[]) => {
      if (!worktreeId) return
      try {
        await invoke('update_worktree_labels', { worktreeId, labels })
        updateCurrentLabels(() => labels)
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      } catch (error) {
        toast.error(`Failed to update marks: ${error}`)
      }
    },
    [worktreeId, updateCurrentLabels, queryClient, projectId]
  )

  const modalProps = useMemo(
    () => ({
      isOpen: target !== null,
      onClose: close,
      sessionId: null,
      currentLabels: target?.currentLabels ?? [],
      target: 'worktree' as const,
      serverId,
      onApplyLabels: apply,
    }),
    [target, close, serverId, apply]
  )

  return {
    open,
    isOpen: target !== null,
    /** Worktree being edited; use it as the modal `key`. */
    targetWorktreeId: worktreeId,
    updateCurrentLabels,
    modalProps,
  }
}
