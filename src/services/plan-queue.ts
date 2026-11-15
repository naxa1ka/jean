import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke, invokeForServer } from '@/lib/transport'
import { parseServerResourceKey, scopeLikeOwner } from '@/lib/server-resource'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type {
  PlanQueue,
  PlanQueueAction,
  PlanQueueSummary,
} from '@/types/plan-queue'

/** All keys start with `plan-queue`, the backend `cache:invalidate` key. */
export const planQueueQueryKeys = {
  all: ['plan-queue'] as const,
  worktree: (worktreeId: string) =>
    [...planQueueQueryKeys.all, 'worktree', worktreeId] as const,
  summaries: (projectId: string) =>
    [...planQueueQueryKeys.all, 'summaries', projectId] as const,
}

export async function getPlanQueue(worktreeId: string): Promise<PlanQueue> {
  return invoke<PlanQueue>('get_plan_queue', { worktreeId })
}

/** Worktree ids in the result are scoped like `projectId`. */
export async function getPlanQueueSummaries(
  projectId: string
): Promise<PlanQueueSummary[]> {
  const projectRef = parseServerResourceKey(projectId)
  const summaries = await invokeForServer<PlanQueueSummary[]>(
    projectRef?.serverId ?? LOCAL_SERVER_ID,
    'get_plan_queue_summaries',
    { projectId: projectRef?.resourceId ?? projectId }
  )
  return summaries.map(summary => ({
    ...summary,
    worktreeId: scopeLikeOwner(projectId, summary.worktreeId),
  }))
}

/** Returns the new plan file name (`NNN-<slug>.md`). */
export async function addPlan(
  worktreeId: string,
  name: string,
  content: string
): Promise<string> {
  return invoke<string>('plan_queue_add', { worktreeId, name, content })
}

export async function reorderPlans(
  worktreeId: string,
  names: string[]
): Promise<void> {
  await invoke('plan_queue_reorder', { worktreeId, names })
}

export async function runPlanQueueAction(
  worktreeId: string,
  action: PlanQueueAction,
  name?: string
): Promise<void> {
  await invoke('plan_queue_action', { worktreeId, action, name })
}

export function usePlanQueue(worktreeId: string | null | undefined) {
  return useQuery({
    queryKey: planQueueQueryKeys.worktree(worktreeId ?? ''),
    queryFn: () => getPlanQueue(worktreeId ?? ''),
    enabled: Boolean(worktreeId),
    staleTime: 5_000,
  })
}

/** Progress data for a project's worktrees. Polls every 10s, like Mr. Robot status. */
export function usePlanQueueSummaries(
  projectId: string | null | undefined,
  enabled = true
) {
  const active = enabled && Boolean(projectId)
  return useQuery({
    queryKey: planQueueQueryKeys.summaries(projectId ?? ''),
    queryFn: () => getPlanQueueSummaries(projectId ?? ''),
    enabled: active,
    refetchInterval: active ? 10_000 : false,
    staleTime: 5_000,
  })
}

function usePlanQueueMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  errorTitle: string
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: planQueueQueryKeys.all })
    },
    onError: error => {
      toast.error(errorTitle, {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useAddPlan() {
  return usePlanQueueMutation(
    (args: { worktreeId: string; name: string; content: string }) =>
      addPlan(args.worktreeId, args.name, args.content),
    'Failed to add plan'
  )
}

export function useReorderPlans() {
  return usePlanQueueMutation(
    (args: { worktreeId: string; names: string[] }) =>
      reorderPlans(args.worktreeId, args.names),
    'Failed to reorder plans'
  )
}

export function usePlanQueueAction() {
  return usePlanQueueMutation(
    (args: { worktreeId: string; action: PlanQueueAction; name?: string }) =>
      runPlanQueueAction(args.worktreeId, args.action, args.name),
    'Plan queue action failed'
  )
}
