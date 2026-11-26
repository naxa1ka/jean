import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import { UNGROUPED_GROUP_ID } from './types'
import {
  resolveWorktreeGroupDrop,
  type ResolveWorktreeGroupDropInput,
  type WorktreeGroupDropSource,
  type WorktreeGroupDropTarget,
} from './worktree-group-drop'

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
  { id: 'g3', name: 'Third', order: 2 },
]

// Flat order: base, a1 (g1), b1 (g2), a2 (g1), c1 (collapsed g3), u1, b2 (g2)
const worktrees = [
  worktree('base', { session_type: 'base' }),
  worktree('a1', { group_id: 'g1' }),
  worktree('b1', { group_id: 'g2' }),
  worktree('a2', { group_id: 'g1' }),
  worktree('c1', { group_id: 'g3' }),
  worktree('u1'),
  worktree('b2', { group_id: 'g2' }),
  worktree('pending', { status: 'pending' }),
  worktree('fix', { origin: 'auto_fix' }),
  worktree('other', { project_id: 'p2' }),
]
const fullOrderedIds = ['base', 'a1', 'b1', 'a2', 'c1', 'u1', 'b2']
const worktreesById = new Map(worktrees.map(w => [w.id, w]))

function resolve(
  source: WorktreeGroupDropSource,
  target: WorktreeGroupDropTarget,
  overrides: Partial<ResolveWorktreeGroupDropInput> = {}
) {
  return resolveWorktreeGroupDrop({
    projectId: 'p1',
    fullOrderedIds,
    worktreesById,
    groups,
    source,
    target,
    ...overrides,
  })
}

const wt = (worktreeId: string): WorktreeGroupDropSource => ({
  kind: 'worktree',
  projectId: 'p1',
  worktreeId,
})
const grp = (groupId: string): WorktreeGroupDropSource => ({
  kind: 'group',
  projectId: 'p1',
  groupId,
})
const onRow = (
  worktreeId: string,
  edge: 'top' | 'bottom' = 'bottom'
): WorktreeGroupDropTarget => ({
  kind: 'row',
  projectId: 'p1',
  worktreeId,
  edge,
})
const onHeader = (
  groupId: string,
  edge: 'top' | 'bottom' | null = null
): WorktreeGroupDropTarget => ({
  kind: 'header',
  projectId: 'p1',
  groupId,
  edge,
})

describe('resolveWorktreeGroupDrop', () => {
  describe('row on row', () => {
    it('reorders inside the same group', () => {
      expect(resolve(wt('a1'), onRow('a2'))).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'b1', 'a2', 'a1', 'c1', 'u1', 'b2'],
      })
      expect(resolve(wt('a2'), onRow('a1', 'top'))).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'a2', 'a1', 'b1', 'c1', 'u1', 'b2'],
      })
    })

    it('moves to the target row group at that position', () => {
      expect(resolve(wt('a1'), onRow('b2', 'top'))).toEqual({
        kind: 'move',
        groupId: 'g2',
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'u1', 'a1', 'b2'],
      })
    })

    it('moves to Ungrouped (null) when the target row has no group', () => {
      expect(resolve(wt('b1'), onRow('u1'))).toEqual({
        kind: 'move',
        groupId: null,
        worktreeIds: ['base', 'a1', 'a2', 'c1', 'u1', 'b1', 'b2'],
      })
    })

    it('reorders all rows like before when the project has no groups', () => {
      expect(resolve(wt('a1'), onRow('b2'), { groups: [] })).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'u1', 'b2', 'a1'],
      })
    })

    it('rejects the base session, pending, auto-fix, other-project and self targets', () => {
      expect(resolve(wt('a1'), onRow('base'))).toBeNull()
      expect(resolve(wt('a1'), onRow('pending'))).toBeNull()
      expect(resolve(wt('a1'), onRow('fix'))).toBeNull()
      expect(resolve(wt('a1'), onRow('other'))).toBeNull()
      expect(resolve(wt('a1'), onRow('a1'))).toBeNull()
      expect(resolve(wt('a1'), onRow('missing'))).toBeNull()
    })

    it('rejects base, pending, auto-fix and other-project sources', () => {
      for (const id of ['base', 'pending', 'fix', 'other', 'missing']) {
        expect(resolve(wt(id), onRow('a2'))).toBeNull()
      }
    })

    it('rejects a target in another project', () => {
      expect(resolve(wt('a1'), { ...onRow('a2'), projectId: 'p2' })).toBeNull()
      expect(resolve(wt('a1'), onRow('a2'), { projectId: 'p2' })).toBeNull()
    })
  })

  describe('row on header', () => {
    it('moves to the end of another group', () => {
      expect(resolve(wt('u1'), onHeader('g1'))).toEqual({
        kind: 'move',
        groupId: 'g1',
        worktreeIds: ['base', 'a1', 'b1', 'a2', 'u1', 'c1', 'b2'],
      })
    })

    it('keeps rows of a collapsed group in the full list', () => {
      const result = resolve(wt('a1'), onHeader('g3'))
      expect(result).toEqual({
        kind: 'move',
        groupId: 'g3',
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'a1', 'u1', 'b2'],
      })
    })

    it('moves to an empty group (end of the list)', () => {
      const withEmpty = [...groups, { id: 'g4', name: 'Empty', order: 3 }]
      expect(resolve(wt('a1'), onHeader('g4'), { groups: withEmpty })).toEqual({
        kind: 'move',
        groupId: 'g4',
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'u1', 'b2', 'a1'],
      })
    })

    it('maps the Ungrouped header to groupId null', () => {
      expect(resolve(wt('a1'), onHeader(UNGROUPED_GROUP_ID))).toEqual({
        kind: 'move',
        groupId: null,
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'u1', 'b2', 'a1'],
      })
    })

    it('reorders to the end of its own group', () => {
      expect(resolve(wt('b1'), onHeader('g2'))).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'a1', 'a2', 'c1', 'u1', 'b2', 'b1'],
      })
      expect(resolve(wt('u1'), onHeader(UNGROUPED_GROUP_ID))).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'a1', 'b1', 'a2', 'c1', 'b2', 'u1'],
      })
    })

    it('rejects unknown groups and projects without groups', () => {
      expect(resolve(wt('a1'), onHeader('nope'))).toBeNull()
      expect(resolve(wt('a1'), onHeader('g1'), { groups: [] })).toBeNull()
      expect(
        resolve(wt('a1'), onHeader(UNGROUPED_GROUP_ID), { groups: [] })
      ).toBeNull()
      expect(resolve(wt('base'), onHeader('g1'))).toBeNull()
      expect(resolve(wt('pending'), onHeader('g1'))).toBeNull()
    })
  })

  describe('canvas row-state rule (rowStateById)', () => {
    const rowStateById = new Map([
      ['a1', 'running'],
      ['a2', 'idle'],
      ['b1', 'waiting'],
      ['b2', 'idle'],
      ['u1', 'idle'],
    ])

    it('rejects a same-group reorder onto a row in another state', () => {
      expect(resolve(wt('a1'), onRow('a2'), { rowStateById })).toBeNull()
    })

    it('allows a same-group reorder onto a row in the same state', () => {
      const sameState = new Map([...rowStateById, ['a1', 'idle']])
      expect(
        resolve(wt('a1'), onRow('a2'), { rowStateById: sameState })
      ).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'b1', 'a2', 'a1', 'c1', 'u1', 'b2'],
      })
    })

    it('allows a move to another group for any state', () => {
      expect(resolve(wt('a1'), onRow('b1', 'top'), { rowStateById })).toEqual({
        kind: 'move',
        groupId: 'g2',
        worktreeIds: ['base', 'a1', 'b1', 'a2', 'c1', 'u1', 'b2'],
      })
      expect(resolve(wt('a1'), onRow('u1'), { rowStateById })).toEqual({
        kind: 'move',
        groupId: null,
        worktreeIds: ['base', 'b1', 'a2', 'c1', 'u1', 'a1', 'b2'],
      })
    })

    it('reorders to the end of its own group on its own header', () => {
      expect(resolve(wt('a1'), onHeader('g1'), { rowStateById })).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'b1', 'a2', 'a1', 'c1', 'u1', 'b2'],
      })
    })

    it('applies the state rule to all rows when the project has no groups', () => {
      expect(
        resolve(wt('a1'), onRow('b2'), { groups: [], rowStateById })
      ).toBeNull()
      expect(
        resolve(wt('a2'), onRow('b2'), { groups: [], rowStateById })
      ).toEqual({
        kind: 'reorder',
        worktreeIds: ['base', 'a1', 'b1', 'c1', 'u1', 'b2', 'a2'],
      })
    })

    it('builds the result from the persisted order, not the display order', () => {
      // Display (grouped, state-sorted) would be: base, a1, a2, b1, b2, c1, u1.
      // The persisted order interleaves groups; the result keeps that order.
      const persisted = ['base', 'b2', 'a2', 'u1', 'a1', 'c1', 'b1']
      expect(
        resolve(wt('a2'), onRow('b1', 'bottom'), {
          fullOrderedIds: persisted,
          rowStateById,
        })
      ).toEqual({
        kind: 'move',
        groupId: 'g2',
        worktreeIds: ['base', 'b2', 'u1', 'a1', 'c1', 'b1', 'a2'],
      })
    })
  })

  describe('group on header', () => {
    it('reorders groups before or after the target', () => {
      expect(resolve(grp('g3'), onHeader('g1', 'top'))).toEqual({
        kind: 'reorderGroups',
        groupIds: ['g3', 'g1', 'g2'],
      })
      expect(resolve(grp('g1'), onHeader('g2', 'bottom'))).toEqual({
        kind: 'reorderGroups',
        groupIds: ['g2', 'g1', 'g3'],
      })
    })

    it('never drags to or onto Ungrouped, itself, rows or unknown groups', () => {
      expect(resolve(grp('g1'), onHeader(UNGROUPED_GROUP_ID))).toBeNull()
      expect(resolve(grp(UNGROUPED_GROUP_ID), onHeader('g1'))).toBeNull()
      expect(resolve(grp('g1'), onHeader('g1'))).toBeNull()
      expect(resolve(grp('g1'), onRow('a1'))).toBeNull()
      expect(resolve(grp('nope'), onHeader('g1'))).toBeNull()
      expect(resolve(grp('g1'), onHeader('nope'))).toBeNull()
      expect(resolve(grp('g1'), onHeader('g2'), { groups: [] })).toBeNull()
    })

    it('rejects a group from another project', () => {
      expect(
        resolve({ ...grp('g1'), projectId: 'p2' }, onHeader('g2'))
      ).toBeNull()
    })
  })
})
