import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Worktree } from '@/types/projects'
import { useWorktreeMarkPicker } from './useWorktreeMarkPicker'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/services/projects', () => ({
  projectsQueryKeys: {
    worktrees: (id: string) => ['projects', id, 'worktrees'],
  },
}))

const worktree = {
  id: 'wt-1',
  labels: [{ name: 'Review later', color: '#3b82f6' }],
} as Worktree

function setup(pinnedLabels?: { name: string; color: string }[]) {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () =>
      useWorktreeMarkPicker({
        projectId: 'p1',
        serverId: 'srv',
        pinnedLabels: pinnedLabels?.map(l => ({ ...l, pinned: true })),
      }),
    { wrapper }
  )
  return { ...hook, invalidate }
}

describe('useWorktreeMarkPicker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens with the worktree marks and closes', () => {
    const { result } = setup()
    expect(result.current.modalProps.isOpen).toBe(false)

    act(() => result.current.open(worktree))
    expect(result.current.modalProps).toMatchObject({
      isOpen: true,
      target: 'worktree',
      serverId: 'srv',
      currentLabels: worktree.labels,
    })
    expect(result.current.targetWorktreeId).toBe('wt-1')

    act(() => result.current.modalProps.onClose())
    expect(result.current.modalProps.isOpen).toBe(false)
  })

  it('marks project pinned labels as pinned when it opens', () => {
    const { result } = setup([{ name: 'review later', color: '#000000' }])
    act(() => result.current.open(worktree))
    expect(result.current.modalProps.currentLabels).toEqual([
      { name: 'Review later', color: '#3b82f6', pinned: true },
    ])
  })

  it('saves the marks and refreshes the worktree list', async () => {
    mocks.invoke.mockResolvedValue(undefined)
    const { result, invalidate } = setup()
    act(() => result.current.open(worktree))

    const next = [{ name: 'Blocked', color: '#ef4444' }]
    await act(() => result.current.modalProps.onApplyLabels(next))

    expect(mocks.invoke).toHaveBeenCalledWith('update_worktree_labels', {
      worktreeId: 'wt-1',
      labels: next,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['projects', 'p1', 'worktrees'],
    })
    expect(result.current.modalProps.currentLabels).toEqual(next)
  })

  it('shows a toast and keeps the marks when the save fails', async () => {
    mocks.invoke.mockRejectedValue('boom')
    const { result, invalidate } = setup()
    act(() => result.current.open(worktree))

    await act(() =>
      result.current.modalProps.onApplyLabels([{ name: 'X', color: '#fff' }])
    )

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Failed to update marks: boom'
      )
    )
    expect(invalidate).not.toHaveBeenCalled()
    expect(result.current.modalProps.currentLabels).toEqual(worktree.labels)
  })
})
