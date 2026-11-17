import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  marksLevel: 1,
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))
vi.mock('@/lib/marks-level', () => ({
  getMarksLevelForResource: () => mocks.marksLevel,
}))

import { useChatStore } from '@/store/chat-store'
import { useImmediateSessionStateSave } from './useImmediateSessionStateSave'

const review = { name: 'Review later', color: '#eab308' }
const blocked = { name: 'Blocked', color: '#ef4444', added_at: 5 }

function lastMarkArgs() {
  const call = mocks.invoke.mock.calls.at(-1)
  expect(call?.[0]).toBe('update_session_state')
  const args = call?.[1] as Record<string, unknown>
  return {
    labels: args.labels,
    label: args.label,
    clearLabel: args.clearLabel,
  }
}

describe('useImmediateSessionStateSave marks', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(null)
    useChatStore.setState({
      sessionLabels: {},
      sessionWorktreeMap: { s1: 'wt-1' },
      worktreePaths: { 'wt-1': '/tmp/wt-1' },
    })
  })

  it('sends the whole labels list at marks level 1', () => {
    mocks.marksLevel = 1
    renderHook(() => useImmediateSessionStateSave())

    useChatStore.getState().setSessionLabels('s1', [review, blocked])
    expect(lastMarkArgs()).toEqual({
      labels: [review, blocked],
      label: undefined,
      clearLabel: undefined,
    })

    useChatStore.getState().setSessionLabels('s1', [])
    expect(lastMarkArgs()).toEqual({
      labels: [],
      label: undefined,
      clearLabel: undefined,
    })
  })

  it('sends the legacy first label and clearLabel at marks level 0', () => {
    mocks.marksLevel = 0
    renderHook(() => useImmediateSessionStateSave())

    useChatStore.getState().setSessionLabels('s1', [review, blocked])
    expect(lastMarkArgs()).toEqual({
      labels: undefined,
      label: review,
      clearLabel: undefined,
    })

    useChatStore.getState().setSessionLabels('s1', [])
    expect(lastMarkArgs()).toEqual({
      labels: undefined,
      label: undefined,
      clearLabel: true,
    })
  })
})
