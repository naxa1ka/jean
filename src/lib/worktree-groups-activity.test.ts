import { describe, expect, it } from 'vitest'
import type { Session, ToolCall, WorktreeSessions } from '@/types/chat'
import {
  getWorktreeGroupActivity,
  type WorktreeActivityState,
} from './worktree-groups-activity'

function state(
  patch: Partial<WorktreeActivityState> = {}
): WorktreeActivityState {
  return {
    sendingSessionIds: {},
    waitingForInputSessionIds: {},
    sessionWorktreeMap: {},
    activeToolCalls: {},
    answeredQuestions: {},
    worktreeLoadingOperations: {},
    ...patch,
  }
}

const askCall = {
  id: 'tc-1',
  name: 'AskUserQuestion',
  input: { questions: [] },
} as unknown as ToolCall

function sessions(
  worktreeId: string,
  list: Partial<Session>[]
): Map<string, WorktreeSessions> {
  return new Map([
    [
      worktreeId,
      {
        worktree_id: worktreeId,
        sessions: list.map((s, i) => ({
          id: `s-${i}`,
          messages: [],
          ...s,
        })),
      } as unknown as WorktreeSessions,
    ],
  ])
}

describe('getWorktreeGroupActivity', () => {
  it('reports none for idle members', () => {
    expect(getWorktreeGroupActivity(state(), ['wt-1'], new Map())).toEqual({
      waiting: false,
      running: false,
    })
  })

  it('reports running for a sending session or a loading operation', () => {
    const sending = state({
      sendingSessionIds: { s1: true },
      sessionWorktreeMap: { s1: 'wt-1' },
    })
    expect(getWorktreeGroupActivity(sending, ['wt-1'], new Map()).running).toBe(
      true
    )
    expect(getWorktreeGroupActivity(sending, ['wt-2'], new Map()).running).toBe(
      false
    )

    const loading = state({ worktreeLoadingOperations: { 'wt-1': 'commit' } })
    expect(getWorktreeGroupActivity(loading, ['wt-1'], new Map()).running).toBe(
      true
    )
  })

  it('lets waiting win over running for a pending AskUserQuestion', () => {
    const live = state({
      sendingSessionIds: { s1: true },
      sessionWorktreeMap: { s1: 'wt-1' },
      activeToolCalls: { s1: [askCall] },
    })
    expect(getWorktreeGroupActivity(live, ['wt-1'], new Map())).toEqual({
      waiting: true,
      running: false,
    })

    const answered = state({
      sessionWorktreeMap: { s1: 'wt-1' },
      activeToolCalls: { s1: [askCall] },
      answeredQuestions: { s1: new Set(['tc-1']) },
    })
    expect(
      getWorktreeGroupActivity(answered, ['wt-1'], new Map()).waiting
    ).toBe(false)
  })

  it('counts explicit and persisted waiting', () => {
    const explicit = state({
      waitingForInputSessionIds: { s1: true },
      sessionWorktreeMap: { s1: 'wt-1' },
    })
    expect(
      getWorktreeGroupActivity(explicit, ['wt-1'], new Map()).waiting
    ).toBe(true)

    const persistedFlag = sessions('wt-1', [
      { waiting_for_input: true, waiting_for_input_type: 'plan' },
    ])
    expect(
      getWorktreeGroupActivity(state(), ['wt-1'], persistedFlag).waiting
    ).toBe(true)

    const persistedQuestion = sessions('wt-1', [
      {
        messages: [
          { id: 'm1', role: 'assistant', tool_calls: [askCall] },
        ] as Session['messages'],
      },
    ])
    expect(
      getWorktreeGroupActivity(state(), ['wt-1'], persistedQuestion).waiting
    ).toBe(true)
    expect(
      getWorktreeGroupActivity(state(), ['wt-2'], persistedQuestion).waiting
    ).toBe(false)
  })
})
