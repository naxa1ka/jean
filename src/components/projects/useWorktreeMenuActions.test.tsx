import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '@/store/projects-store'
import type { Project, Worktree } from '@/types/projects'
import { useWorktreeMenuActions } from './useWorktreeMenuActions'

const mocks = vi.hoisted(() => ({
  move: vi.fn(),
  projects: [] as Project[],
}))

vi.mock('@/services/projects', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() })
  return {
    projectsQueryKeys: {
      worktrees: (projectId: string) => ['projects', 'worktrees', projectId],
    },
    useArchiveWorktree: mutation,
    useDeleteWorktree: mutation,
    useOpenWorktreeInFinder: mutation,
    useOpenWorktreeInTerminal: mutation,
    useOpenWorktreeInEditor: mutation,
    useCreateWorktreeGroup: mutation,
    useMoveWorktreeToGroup: () => ({ mutate: mocks.move }),
    useProjects: () => ({ data: mocks.projects }),
    useRunScripts: () => ({ data: [] }),
  }
})
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))
vi.mock('@/services/chat', () => ({ useSessions: () => ({ data: undefined }) }))
vi.mock('@/lib/worktree-groups-level', () => ({
  useWorktreeGroupsSupported: () => true,
}))

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    project_id: 'p1',
    name: id,
    path: `/tmp/${id}`,
    branch: id,
    created_at: 1,
    order: 0,
    ...overrides,
  }
}

const all = [
  worktree('base', { session_type: 'base' }),
  worktree('a', { order: 1, group_id: 'g1' }),
  worktree('b', { order: 2 }),
  worktree('c', { order: 3, group_id: 'g1' }),
  worktree('d', { order: 4 }),
]

function setup(target: Worktree) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['projects', 'worktrees', 'p1'], all)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    () => useWorktreeMenuActions({ worktree: target, projectId: 'p1' }),
    { wrapper }
  ).result
}

describe('useWorktreeMenuActions move to group', () => {
  beforeEach(() => {
    mocks.move.mockReset()
    mocks.projects = [
      {
        id: 'p1',
        name: 'Project',
        worktree_groups: [{ id: 'g1', name: 'Bugs', order: 0 }],
      } as Project,
    ]
    useProjectsStore.setState({ projectCanvasSettings: {} })
  })

  it('sends the full order with the worktree at the end of the group in manual mode', () => {
    useProjectsStore.setState({
      projectCanvasSettings: { p1: { worktreeSortMode: 'manual' } },
    })
    const result = setup(all[4] as Worktree)
    act(() => result.current.handleMoveToGroup('g1'))

    expect(mocks.move).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'd',
      groupId: 'g1',
      worktreeIds: ['base', 'a', 'b', 'c', 'd'],
      switchToManualSort: false,
    })
  })

  it('moves to the end of the ungrouped worktrees in manual mode', () => {
    useProjectsStore.setState({
      projectCanvasSettings: { p1: { worktreeSortMode: 'manual' } },
    })
    const result = setup(all[1] as Worktree)
    expect(result.current.currentGroupId).toBe('g1')
    act(() => result.current.handleMoveToGroup(null))

    expect(mocks.move).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: null,
        worktreeIds: ['base', 'b', 'c', 'd', 'a'],
      })
    )
  })

  it('sends no order in other sort modes', () => {
    const result = setup(all[2] as Worktree)
    act(() => result.current.handleMoveToGroup('g1'))

    expect(mocks.move).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'b',
      groupId: 'g1',
      switchToManualSort: false,
    })
  })

  it('does not offer the move for the base session', () => {
    expect(setup(all[0] as Worktree).current.canMoveToGroup).toBe(false)
    expect(setup(all[2] as Worktree).current.canMoveToGroup).toBe(true)
  })
})
