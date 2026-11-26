import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { useProjectsStore } from '@/store/projects-store'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import { WorktreeList } from './WorktreeList'

const env = vi.hoisted(() => ({ supported: true }))

vi.mock('./WorktreeItem', () => ({
  WorktreeItem: ({ worktree }: { worktree: Worktree }) => (
    <div data-testid="worktree-row">{worktree.name}</div>
  ),
}))
vi.mock('@/lib/marks', () => ({ useMarkDefinitions: () => [] }))
vi.mock('@/lib/worktree-groups-level', () => ({
  useWorktreeGroupsSupported: () => env.supported,
}))
vi.mock('@/services/projects', () => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  })
  return {
    isTauri: () => false,
    WORKTREE_GROUP_MUTATION_KEY: ['worktree-group-mutation'],
    useReorderWorktrees: mutation,
    useRenameWorktreeGroup: mutation,
    useDeleteWorktreeGroup: mutation,
    useCreateWorktreeGroup: mutation,
    useMoveWorktreeToGroup: mutation,
    useReorderWorktreeGroups: mutation,
  }
})

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    project_id: 'p1',
    name: id,
    // No path: the session list queries stay disabled
    path: '',
    branch: id,
    created_at: 1,
    order: 0,
    ...overrides,
  }
}

const groups: WorktreeGroup[] = [
  { id: 'g1', name: 'Bugs', order: 0 },
  { id: 'g2', name: 'Empty', order: 1 },
]

const worktrees = [
  worktree('base', { session_type: 'base' }),
  worktree('bug-1', { group_id: 'g1' }),
  worktree('loose'),
]

function renderList(props: {
  groups?: WorktreeGroup[]
  worktrees?: Worktree[]
}) {
  return render(
    <WorktreeList
      projectId="p1"
      projectPath="/repo"
      defaultBranch="main"
      worktrees={props.worktrees ?? worktrees}
      groups={props.groups}
    />
  )
}

const rows = () =>
  screen.queryAllByTestId('worktree-row').map(r => r.textContent)
const header = (id: string) =>
  document.querySelector(
    `[data-worktree-group-id="${id}"][data-worktree-group-project-id="p1"][data-worktree-group-scope="worktree-list"]`
  )

describe('WorktreeList with groups', () => {
  beforeEach(() => {
    env.supported = true
    useProjectsStore.setState({ collapsedWorktreeGroupKeys: new Set() })
  })

  it('renders base, groups, then Ungrouped, and hides rows of a collapsed group', () => {
    useProjectsStore.setState({ collapsedWorktreeGroupKeys: new Set(['g1']) })
    renderList({ groups })

    expect(header('g1')).not.toBeNull()
    expect(rows()).toEqual(['base', 'loose'])
  })

  it('shows a header for an empty group and an empty Ungrouped bucket', () => {
    renderList({
      groups,
      worktrees: [worktree('bug-1', { group_id: 'g1' })],
    })

    expect(header('g2')).not.toBeNull()
    expect(header('ungrouped')).not.toBeNull()
    expect(header('g2')?.textContent).toContain('0')
    expect(header('ungrouped')?.textContent).toContain('0')
    expect(rows()).toEqual(['bug-1'])
  })

  it('collapses Ungrouped by the project id', () => {
    useProjectsStore.setState({ collapsedWorktreeGroupKeys: new Set(['p1']) })
    renderList({ groups })
    expect(rows()).toEqual(['base', 'bug-1'])
  })

  it('renders the flat list for a project without groups', () => {
    renderList({ groups: [] })
    expect(document.querySelector('[data-worktree-group-id]')).toBeNull()
    expect(rows()).toEqual(['base', 'bug-1', 'loose'])
  })

  it('renders the flat list when the server has no group support', () => {
    env.supported = false
    renderList({ groups })
    expect(document.querySelector('[data-worktree-group-id]')).toBeNull()
    expect(rows()).toEqual(['base', 'bug-1', 'loose'])
  })
})
