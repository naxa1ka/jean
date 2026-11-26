import {
  isAskUserQuestion,
  isPlanToolCall,
  type Session,
  type ToolCall,
  type WorktreeSessions,
} from '@/types/chat'

/** The chat store fields that decide whether a worktree waits or runs. */
export interface WorktreeActivityState {
  sendingSessionIds: Record<string, boolean>
  waitingForInputSessionIds: Record<string, boolean>
  sessionWorktreeMap: Record<string, string>
  activeToolCalls: Record<string, ToolCall[]>
  answeredQuestions: Record<string, Set<string>>
  worktreeLoadingOperations: Record<string, string | null>
}

export interface WaitingKinds {
  /** AskUserQuestion or explicit wait (blinks) */
  question: boolean
  /** Plan waiting for approval (solid) */
  plan: boolean
}

type IsMember = (worktreeId: string) => boolean

/**
 * Waiting from live store state: unanswered streaming AskUserQuestion / plan
 * calls and explicit waiting-for-input flags, for sessions of member worktrees.
 */
export function getLiveWaiting(
  state: WorktreeActivityState,
  isMember: IsMember
): WaitingKinds {
  let question = false
  let plan = false
  for (const [sessionId, toolCalls] of Object.entries(state.activeToolCalls)) {
    const worktreeId = state.sessionWorktreeMap[sessionId]
    if (!worktreeId || !isMember(worktreeId)) continue
    const answered = state.answeredQuestions[sessionId]
    const isOpen = (tc: ToolCall) => !answered?.has(tc.id)
    if (!question && toolCalls.some(tc => isAskUserQuestion(tc) && isOpen(tc)))
      question = true
    if (
      !plan &&
      !state.sendingSessionIds[sessionId] &&
      toolCalls.some(tc => isPlanToolCall(tc) && isOpen(tc))
    )
      plan = true
    if (question && plan) return { question, plan }
  }
  if (!question) {
    for (const [sessionId, isWaiting] of Object.entries(
      state.waitingForInputSessionIds
    )) {
      const worktreeId = state.sessionWorktreeMap[sessionId]
      if (isWaiting && worktreeId && isMember(worktreeId)) {
        question = true
        break
      }
    }
  }
  return { question, plan }
}

/**
 * Waiting from persisted sessions: an unanswered AskUserQuestion or plan in the
 * last assistant message, or the persisted `waiting_for_input` flag. Sessions
 * that are sending now are skipped for the message scan (live state covers them).
 */
export function getPersistedWaiting(
  sessions: readonly Session[],
  sendingSessionIds: Record<string, boolean>,
  answeredQuestions: Record<string, Set<string>>
): WaitingKinds {
  let question = false
  let plan = false
  for (const session of sessions) {
    if (session.waiting_for_input) {
      if (session.waiting_for_input_type === 'question') question = true
      if (session.waiting_for_input_type === 'plan') plan = true
    }
    if (sendingSessionIds[session.id]) continue

    // A later user message means the last assistant message was answered.
    let lastAssistant = null
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const role = session.messages[i]?.role
      if (role === 'user') break
      if (role === 'assistant') {
        lastAssistant = session.messages[i]
        break
      }
    }
    if (
      lastAssistant?.tool_calls?.some(
        tc =>
          isAskUserQuestion(tc) && !answeredQuestions[session.id]?.has(tc.id)
      )
    )
      question = true

    // Plans: the last assistant message, even after a user message.
    const approvedPlanIds = session.approved_plan_message_ids
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]
      if (msg?.role !== 'assistant') continue
      if (
        msg.tool_calls?.some(isPlanToolCall) &&
        !msg.plan_approved &&
        !approvedPlanIds?.includes(msg.id)
      )
        plan = true
      break
    }
    if (question && plan) break
  }
  return { question, plan }
}

/** Whether a member worktree has a sending session or a loading operation. */
export function isAnyWorktreeRunning(
  state: WorktreeActivityState,
  worktreeIds: readonly string[]
): boolean {
  if (worktreeIds.some(id => state.worktreeLoadingOperations[id])) return true
  const members = new Set(worktreeIds)
  for (const [sessionId, isSending] of Object.entries(
    state.sendingSessionIds
  )) {
    const worktreeId = state.sessionWorktreeMap[sessionId]
    if (isSending && worktreeId && members.has(worktreeId)) return true
  }
  return false
}

/** Summary for a group header: same signals as each worktree row. */
export function getWorktreeGroupActivity(
  state: WorktreeActivityState,
  worktreeIds: readonly string[],
  sessionsByWorktreeId: ReadonlyMap<string, WorktreeSessions>
): { waiting: boolean; running: boolean } {
  const members = new Set(worktreeIds)
  const live = getLiveWaiting(state, id => members.has(id))
  let waiting = live.question || live.plan
  if (!waiting) {
    for (const id of worktreeIds) {
      const sessions = sessionsByWorktreeId.get(id)?.sessions
      if (!sessions) continue
      const persisted = getPersistedWaiting(
        sessions,
        state.sendingSessionIds,
        state.answeredQuestions
      )
      if (persisted.question || persisted.plan) {
        waiting = true
        break
      }
    }
  }
  return {
    waiting,
    running: !waiting && isAnyWorktreeRunning(state, worktreeIds),
  }
}
