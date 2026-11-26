import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import {
  canGroupWorktree,
  effectiveGroupId,
  groupWorktrees,
  orderForMoveToGroupEnd,
  persistedWorktreeOrder,
} from './worktree-groups'

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

const groups: WorktreeGroup[] = [
  { id: 'g2', name: 'Second', order: 1 },
  { id: 'g1', name: 'First', order: 0 },
  { id: 'g3', name: 'Empty', order: 2 },
]

const ids = (list: Worktree[]) => list.map(w => w.id)

describe('groupWorktrees', () => {
  it('splits worktrees into base, pending, sorted groups and ungrouped', () => {
    const base = worktree('base', { session_type: 'base' })
    const result = groupWorktrees(
      [
        base,
        worktree('a', { group_id: 'g2' }),
        worktree('b', { group_id: 'g1' }),
        worktree('c'),
        worktree('d', { group_id: 'g2' }),
        worktree('e', { status: 'pending', group_id: 'g1' }),
      ],
      groups
    )

    expect(result.base).toBe(base)
    expect(ids(result.pending)).toEqual(['e'])
    expect(result.groups.map(g => g.group.id)).toEqual(['g1', 'g2', 'g3'])
    expect(result.groups.map(g => ids(g.worktrees))).toEqual([
      ['b'],
      ['a', 'd'],
      [],
    ])
    expect(ids(result.ungrouped)).toEqual(['c'])
  })

  it('keeps the incoming order inside each bucket', () => {
    const result = groupWorktrees(
      [
        worktree('z', { group_id: 'g1' }),
        worktree('y'),
        worktree('x', { group_id: 'g1' }),
        worktree('w'),
      ],
      groups
    )
    expect(ids(result.groups[0]?.worktrees ?? [])).toEqual(['z', 'x'])
    expect(ids(result.ungrouped)).toEqual(['y', 'w'])
  })

  it('treats unknown group ids and auto-fix worktrees as ungrouped', () => {
    const result = groupWorktrees(
      [
        worktree('a', { group_id: 'missing' }),
        worktree('b', { group_id: 'g1', origin: 'auto_fix' }),
      ],
      groups
    )
    expect(result.groups.every(g => g.worktrees.length === 0)).toBe(true)
    expect(ids(result.ungrouped)).toEqual(['a', 'b'])
  })

  it('returns no groups when the project has none', () => {
    const result = groupWorktrees(
      [worktree('a', { group_id: 'g1' })],
      undefined
    )
    expect(result.groups).toEqual([])
    expect(result.base).toBeNull()
    expect(ids(result.ungrouped)).toEqual(['a'])
  })
})

describe('canGroupWorktree', () => {
  it('allows ready, error and legacy worktrees only', () => {
    expect(canGroupWorktree(worktree('a'))).toBe(true)
    expect(canGroupWorktree(worktree('a', { status: 'ready' }))).toBe(true)
    expect(canGroupWorktree(worktree('a', { status: 'error' }))).toBe(true)
    expect(canGroupWorktree(worktree('a', { status: 'pending' }))).toBe(false)
    expect(canGroupWorktree(worktree('a', { status: 'deleting' }))).toBe(false)
    expect(canGroupWorktree(worktree('a', { session_type: 'base' }))).toBe(
      false
    )
    expect(canGroupWorktree(worktree('a', { origin: 'auto_fix' }))).toBe(false)
  })
})

describe('effectiveGroupId', () => {
  it('returns the group id only when the group exists', () => {
    expect(effectiveGroupId(worktree('a', { group_id: 'g1' }), groups)).toBe(
      'g1'
    )
    expect(
      effectiveGroupId(worktree('a', { group_id: 'missing' }), groups)
    ).toBeNull()
    expect(effectiveGroupId(worktree('a', { group_id: null }), groups)).toBe(
      null
    )
    expect(effectiveGroupId(worktree('a'), groups)).toBeNull()
  })
})

describe('orderForMoveToGroupEnd', () => {
  const list = [
    worktree('base', { session_type: 'base' }),
    worktree('a', { group_id: 'g1' }),
    worktree('b'),
    worktree('c', { group_id: 'g1' }),
    worktree('d', { group_id: 'g2' }),
    worktree('e'),
  ]
  const byId = new Map(list.map(w => [w.id, w]))
  const full = ids(list)

  it('places the worktree right after the last member of the group', () => {
    expect(orderForMoveToGroupEnd(full, byId, 'e', 'g1', groups)).toEqual([
      'base',
      'a',
      'b',
      'c',
      'e',
      'd',
    ])
  })

  it('ignores the moved worktree itself when finding the last member', () => {
    expect(orderForMoveToGroupEnd(full, byId, 'c', 'g1', groups)).toEqual([
      'base',
      'a',
      'c',
      'b',
      'd',
      'e',
    ])
  })

  it('moves to the end for an empty group or ungrouped', () => {
    expect(orderForMoveToGroupEnd(full, byId, 'a', 'g3', groups)).toEqual([
      'base',
      'b',
      'c',
      'd',
      'e',
      'a',
    ])
    expect(orderForMoveToGroupEnd(full, byId, 'a', null, groups)).toEqual([
      'base',
      'b',
      'c',
      'd',
      'e',
      'a',
    ])
  })
})

describe('persistedWorktreeOrder', () => {
  it('sorts by manual order with the base session first and skips transient rows', () => {
    expect(
      persistedWorktreeOrder([
        worktree('b', { order: 2 }),
        worktree('pending', { order: 0, status: 'pending' }),
        worktree('a', { order: 1 }),
        worktree('base', { session_type: 'base', order: 5 }),
        worktree('deleting', { order: 3, status: 'deleting' }),
        worktree('fix', { order: 0, origin: 'auto_fix' }),
      ])
    ).toEqual(['base', 'a', 'b'])
  })
})
