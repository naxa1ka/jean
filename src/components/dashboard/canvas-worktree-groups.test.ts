import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeGroup } from '@/types/projects'
import type { CanvasRowState } from './canvas-row-state'
import {
  buildCanvasGroupedList,
  findGroupedKeyboardMoveTarget,
  nearestVisibleWorktreeId,
  type CanvasGroupedItem,
} from './canvas-worktree-groups'

interface Section {
  worktree: Worktree
  isPending?: boolean
  state?: CanvasRowState
}

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

function section(
  id: string,
  overrides: Partial<Worktree> = {},
  state: CanvasRowState = 'idle'
): Section {
  return { worktree: worktree(id, overrides), state }
}

const groups: WorktreeGroup[] = [
  { id: 'g2', name: 'Second', order: 1 },
  { id: 'g1', name: 'First', order: 0 },
]

function build(
  sections: Section[],
  options: {
    collapsed?: string[]
    search?: boolean
    tab?: string
    groupList?: WorktreeGroup[]
  } = {}
) {
  return buildCanvasGroupedList({
    sections,
    groups: options.groupList ?? groups,
    projectId: 'p1',
    collapsedKeys: new Set(options.collapsed ?? []),
    hasSearchQuery: options.search ?? false,
    activeFilterTab: options.tab ?? 'all',
    getRowState: s => s.state ?? 'idle',
  })
}

/** Compact picture of the render order: `#g1` headers, `id` rows. */
function shape(items: CanvasGroupedItem<Section>[]): string[] {
  return items.map(item =>
    item.kind === 'header'
      ? `#${item.group?.id ?? 'ungrouped'}${item.isCollapsed ? '-' : ''}:${item.memberIds.length}`
      : item.section.worktree.id
  )
}

const ids = (rows: Section[]) => rows.map(r => r.worktree.id)

describe('buildCanvasGroupedList', () => {
  it('puts pending and base first, then groups by order, then Ungrouped', () => {
    const pending: Section = {
      worktree: worktree('new', { status: 'pending' }),
      isPending: true,
    }
    const result = build([
      pending,
      section('base', { session_type: 'base' }),
      section('a', { group_id: 'g2' }),
      section('b', { group_id: 'g1' }),
      section('c'),
      section('d', { group_id: 'missing' }),
    ])
    expect(shape(result.items)).toEqual([
      'new',
      'base',
      '#g1:1',
      'b',
      '#g2:1',
      'a',
      '#ungrouped:2',
      'c',
      'd',
    ])
  })

  it('sorts rows by state inside a group and keeps the order otherwise', () => {
    const result = build([
      section('a', { group_id: 'g1' }, 'idle'),
      section('b', { group_id: 'g1' }, 'running'),
      section('c', { group_id: 'g1' }, 'idle'),
      section('d', { group_id: 'g1' }, 'waiting'),
    ])
    expect(ids(result.visibleRows)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('leaves rows of collapsed groups out of the visible list', () => {
    const result = build(
      [section('a', { group_id: 'g1' }), section('b'), section('c')],
      { collapsed: ['g1', 'p1'] }
    )
    expect(shape(result.items)).toEqual(['#g1-:1', '#g2:0', '#ungrouped-:2'])
    expect(ids(result.visibleRows)).toEqual([])
    expect(ids(result.allRows)).toEqual(['a', 'b', 'c'])
  })

  it('shows matches expanded and hides empty groups while searching', () => {
    const result = build([section('a', { group_id: 'g1' })], {
      collapsed: ['g1'],
      search: true,
    })
    expect(shape(result.items)).toEqual(['#g1:1', 'a'])
  })

  it('shows empty groups on the all tab, hides them on other tabs', () => {
    const sections = [section('a', { group_id: 'g1' })]
    expect(shape(build(sections).items)).toEqual([
      '#g1:1',
      'a',
      '#g2:0',
      '#ungrouped:0',
    ])
    expect(
      shape(build(sections, { tab: 'prs', collapsed: ['g1'] }).items)
    ).toEqual(['#g1-:1'])
  })

  it('keeps the incoming order with no groups (only Ungrouped)', () => {
    const result = build([section('a'), section('b')], { groupList: [] })
    expect(ids(result.visibleRows)).toEqual(['a', 'b'])
  })
})

describe('nearestVisibleWorktreeId', () => {
  const all = ['a', 'b', 'c', 'd']

  it('prefers the next visible row', () => {
    expect(nearestVisibleWorktreeId(all, new Set(['a', 'd']), 'b')).toBe('d')
  })

  it('falls back to the previous visible row', () => {
    expect(nearestVisibleWorktreeId(all, new Set(['a']), 'c')).toBe('a')
  })

  it('returns null when nothing is visible or the id is unknown', () => {
    expect(nearestVisibleWorktreeId(all, new Set(), 'b')).toBeNull()
    expect(nearestVisibleWorktreeId(all, new Set(['a']), 'x')).toBeNull()
  })
})

describe('findGroupedKeyboardMoveTarget', () => {
  const worktrees = [
    worktree('a', { group_id: 'g1' }),
    worktree('b', { group_id: 'g1' }),
    worktree('c', { group_id: 'g1' }),
    worktree('d', { group_id: 'g2' }),
  ]
  const worktreesById = new Map(worktrees.map(w => [w.id, w]))
  const rowStateById = new Map<string, CanvasRowState>([
    ['a', 'idle'],
    ['b', 'idle'],
    ['c', 'running'],
    ['d', 'running'],
  ])
  const find = (activeId: string, direction: -1 | 1) =>
    findGroupedKeyboardMoveTarget({
      visibleIds: ['a', 'b', 'c', 'd'],
      activeId,
      direction,
      worktreesById,
      groups,
      rowStateById,
    })

  it('moves next to a neighbour with the same group and state', () => {
    expect(find('a', 1)).toBe('b')
    expect(find('b', -1)).toBe('a')
  })

  it('does not cross a row state or a group', () => {
    expect(find('b', 1)).toBeNull()
    expect(find('c', 1)).toBeNull()
    expect(find('a', -1)).toBeNull()
  })
})
