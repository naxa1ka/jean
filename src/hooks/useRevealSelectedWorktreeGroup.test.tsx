import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { projectsQueryKeys } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import type { Project, Worktree } from '@/types/projects'
import { useRevealSelectedWorktreeGroup } from './useRevealSelectedWorktreeGroup'

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

function setup(isInitialized = true) {
  const queryClient = new QueryClient()
  queryClient.setQueryData<Project[]>(projectsQueryKeys.list(), [
    {
      id: 'p1',
      name: 'Project',
      worktree_groups: [{ id: 'g1', name: 'Bugs', order: 0 }],
    } as Project,
  ])
  queryClient.setQueryData<Worktree[]>(projectsQueryKeys.worktrees('p1'), [
    worktree('wt-in-group', { group_id: 'g1' }),
    worktree('wt-ungrouped'),
  ])
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    ({ ready }: { ready: boolean }) => useRevealSelectedWorktreeGroup(ready),
    { wrapper, initialProps: { ready: isInitialized } }
  )
}

const collapsed = () => useProjectsStore.getState().collapsedWorktreeGroupKeys

describe('useRevealSelectedWorktreeGroup', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      selectedWorktreeId: null,
      collapsedWorktreeGroupKeys: new Set(['g1', 'p1']),
    })
  })

  it('expands the group of a newly selected worktree', () => {
    setup()
    act(() => useProjectsStore.getState().selectWorktree('wt-in-group'))
    expect(collapsed().has('g1')).toBe(false)
    expect(collapsed().has('p1')).toBe(true)

    act(() => useProjectsStore.getState().selectWorktree('wt-ungrouped'))
    expect(collapsed().has('p1')).toBe(false)
  })

  it('keeps a saved collapse on startup', () => {
    useProjectsStore.setState({ selectedWorktreeId: 'wt-in-group' })
    const { rerender } = setup(false)
    act(() => useProjectsStore.getState().selectWorktree('wt-ungrouped'))
    expect(collapsed()).toEqual(new Set(['g1', 'p1']))

    rerender({ ready: true })
    expect(collapsed()).toEqual(new Set(['g1', 'p1']))
  })

  it('does not undo a collapse of the selected worktree group', () => {
    setup()
    act(() => useProjectsStore.getState().selectWorktree('wt-in-group'))
    act(() => useProjectsStore.getState().setWorktreeGroupCollapsed('g1', true))
    expect(collapsed().has('g1')).toBe(true)
  })
})
