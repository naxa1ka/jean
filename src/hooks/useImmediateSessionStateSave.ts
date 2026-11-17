import { useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import type { ManualSessionStatus } from '@/store/chat-store'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { LabelData } from '@/types/chat'
import { isSessionStateHydrating } from '@/lib/session-state-hydration'
import { isBackendPersisting } from '@/lib/backend-persist-guard'
import { getMarksLevelForResource } from '@/lib/marks-level'

/**
 * Saves reviewing/waiting/status-override state immediately when it changes.
 * These states change infrequently, so no debounce needed.
 * Fixes the issue where debounced saves don't complete before app close.
 */
export function useImmediateSessionStateSave() {
  // PERFORMANCE: Track previous references (not spreads) to short-circuit early.
  // Zustand creates new object references on mutation, so referential equality
  // tells us if the specific record changed — no need to iterate entries.
  const prevAnsweredRef = useRef<Record<string, Set<string>>>({})
  const prevSubmittedRef = useRef<Record<string, Record<string, unknown>>>({})
  const prevReviewingRef = useRef<Record<string, boolean>>({})
  const prevStatusOverridesRef = useRef<Record<string, ManualSessionStatus>>({})
  const prevWaitingRef = useRef<Record<string, boolean>>({})
  const prevLabelsRef = useRef<Record<string, LabelData[]>>({})

  useEffect(() => {
    const initialState = useChatStore.getState()
    prevAnsweredRef.current = initialState.answeredQuestions
    prevSubmittedRef.current = initialState.submittedAnswers as Record<
      string,
      Record<string, unknown>
    >
    prevReviewingRef.current = initialState.reviewingSessions
    prevStatusOverridesRef.current = initialState.sessionStatusOverrides
    prevWaitingRef.current = initialState.waitingForInputSessionIds
    prevLabelsRef.current = initialState.sessionLabels

    const unsubscribe = useChatStore.subscribe(state => {
      if (isSessionStateHydrating()) {
        prevAnsweredRef.current = state.answeredQuestions
        prevSubmittedRef.current = state.submittedAnswers as Record<
          string,
          Record<string, unknown>
        >
        prevReviewingRef.current = state.reviewingSessions
        prevStatusOverridesRef.current = state.sessionStatusOverrides
        prevWaitingRef.current = state.waitingForInputSessionIds
        prevLabelsRef.current = state.sessionLabels
        return
      }

      const {
        answeredQuestions,
        submittedAnswers,
        reviewingSessions,
        sessionStatusOverrides,
        waitingForInputSessionIds,
        sessionLabels,
        sessionWorktreeMap,
        worktreePaths,
      } = state

      // Short-circuit: skip all iteration if no relevant record changed
      const answeredChanged = answeredQuestions !== prevAnsweredRef.current
      const submittedChanged = submittedAnswers !== prevSubmittedRef.current
      const reviewingChanged = reviewingSessions !== prevReviewingRef.current
      const statusOverridesChanged =
        sessionStatusOverrides !== prevStatusOverridesRef.current
      const waitingChanged =
        waitingForInputSessionIds !== prevWaitingRef.current
      const labelsChanged = sessionLabels !== prevLabelsRef.current

      if (
        !answeredChanged &&
        !submittedChanged &&
        !reviewingChanged &&
        !statusOverridesChanged &&
        !waitingChanged &&
        !labelsChanged
      ) {
        return
      }

      if (answeredChanged || submittedChanged) {
        const sessionIds = new Set([
          ...Object.keys(prevAnsweredRef.current),
          ...Object.keys(answeredQuestions),
          ...Object.keys(prevSubmittedRef.current),
          ...Object.keys(submittedAnswers),
        ])

        for (const sessionId of sessionIds) {
          const answeredDiff =
            prevAnsweredRef.current[sessionId] !== answeredQuestions[sessionId]
          const submittedDiff =
            prevSubmittedRef.current[sessionId] !== submittedAnswers[sessionId]

          if (!answeredDiff && !submittedDiff) continue

          saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
            answeredQuestions: Array.from(answeredQuestions[sessionId] ?? []),
            submittedAnswers:
              (submittedAnswers[sessionId] as Record<string, unknown>) ?? {},
          })
        }

        prevAnsweredRef.current = answeredQuestions
        prevSubmittedRef.current = submittedAnswers as Record<
          string,
          Record<string, unknown>
        >
      }

      if (reviewingChanged) {
        for (const [sessionId, isReviewing] of Object.entries(
          reviewingSessions
        )) {
          if (prevReviewingRef.current[sessionId] !== isReviewing) {
            // Skip if backend is persisting completion state for this session
            // Prefer status_override path when both change together.
            if (!isBackendPersisting(sessionId) && !statusOverridesChanged) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                isReviewing,
              })
            }
          }
        }
        for (const sessionId of Object.keys(prevReviewingRef.current)) {
          if (!(sessionId in reviewingSessions)) {
            if (!isBackendPersisting(sessionId) && !statusOverridesChanged) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                isReviewing: false,
              })
            }
          }
        }
        prevReviewingRef.current = reviewingSessions
      }

      if (statusOverridesChanged) {
        const sessionIds = new Set([
          ...Object.keys(prevStatusOverridesRef.current),
          ...Object.keys(sessionStatusOverrides),
        ])
        for (const sessionId of sessionIds) {
          const prev = prevStatusOverridesRef.current[sessionId] ?? null
          const next = sessionStatusOverrides[sessionId] ?? null
          if (prev === next) continue
          if (isBackendPersisting(sessionId)) continue
          saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
            statusOverride: next,
            // Keep isReviewing aligned for legacy readers
            isReviewing: next === 'review',
          })
        }
        prevStatusOverridesRef.current = sessionStatusOverrides
      }

      if (waitingChanged) {
        for (const [sessionId, isWaiting] of Object.entries(
          waitingForInputSessionIds
        )) {
          if (prevWaitingRef.current[sessionId] !== isWaiting) {
            // Skip if backend is persisting completion state for this session
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                waitingForInput: isWaiting,
              })
            }
          }
        }
        for (const sessionId of Object.keys(prevWaitingRef.current)) {
          if (!(sessionId in waitingForInputSessionIds)) {
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                waitingForInput: false,
              })
            }
          }
        }
        prevWaitingRef.current = waitingForInputSessionIds
      }

      if (labelsChanged) {
        for (const [sessionId, labels] of Object.entries(sessionLabels)) {
          if (prevLabelsRef.current[sessionId] !== labels) {
            saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
              labels,
            })
          }
        }
        for (const sessionId of Object.keys(prevLabelsRef.current)) {
          if (!(sessionId in sessionLabels)) {
            saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
              labels: [],
            })
          }
        }
        prevLabelsRef.current = sessionLabels
      }
    })

    return unsubscribe
  }, [])
}

async function saveSessionStatus(
  sessionId: string,
  sessionWorktreeMap: Record<string, string>,
  worktreePaths: Record<string, string>,
  updates: {
    answeredQuestions?: string[]
    submittedAnswers?: Record<string, unknown>
    isReviewing?: boolean
    statusOverride?: ManualSessionStatus | null
    waitingForInput?: boolean
    labels?: LabelData[]
  }
) {
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : null

  if (!worktreeId || !worktreePath) {
    logger.warn('Cannot save session status: missing worktree info', {
      sessionId,
    })
    return
  }

  try {
    // statusOverride: undefined = leave unchanged, null = clear, string = set
    const hasStatusOverride = 'statusOverride' in updates
    await invoke('update_session_state', {
      worktreeId,
      worktreePath,
      sessionId,
      answeredQuestions: updates.answeredQuestions,
      submittedAnswers: updates.submittedAnswers,
      isReviewing: updates.isReviewing,
      ...(hasStatusOverride
        ? { statusOverride: updates.statusOverride ?? null }
        : {}),
      waitingForInput: updates.waitingForInput,
      ...markArgs(worktreeId, updates.labels),
    })
  } catch (error) {
    logger.error('Failed to save session status', { sessionId, error })
  }
}

/**
 * Mark args for `update_session_state`. Servers with `marks >= 1` take the whole
 * `labels` list; older servers take one `label` (the first mark) or `clearLabel`.
 */
function markArgs(
  worktreeId: string,
  labels: LabelData[] | undefined
): Record<string, unknown> {
  if (!labels) return {}
  if (getMarksLevelForResource(worktreeId) >= 1) return { labels }
  const [first] = labels
  return first ? { label: first } : { clearLabel: true }
}
