import { describe, expect, it } from 'vitest'
import {
  applyWorktreeDropSnapshot,
  getClosestVerticalEdge,
  getSnapshotFromWorktreeListElement,
  getWorktreeDropTargetForScope,
  getWorktreeListDropSnapshot,
  getWorktreeListElement,
} from './worktree-reorder-ux'
import {
  DRAG_SCOPE_CANVAS_WORKTREE_LIST,
  DRAG_SCOPE_WORKTREE_LIST,
  DROP_TYPE_WORKTREE_GROUP_HEADER,
} from './types'

describe('worktree reorder UX helpers', () => {
  it('detects top and bottom vertical edges from pointer position', () => {
    const rect = { top: 100, height: 40 }

    expect(getClosestVerticalEdge({ clientY: 119, rect })).toBe('top')
    expect(getClosestVerticalEdge({ clientY: 120, rect })).toBe('bottom')
  })

  it('keeps drag state referentially stable for unchanged target snapshots', () => {
    const state = {
      draggingId: 'source',
      targetId: 'target',
      closestEdge: 'top' as const,
    }

    expect(
      applyWorktreeDropSnapshot(state, {
        targetId: 'target',
        closestEdge: 'top',
      })
    ).toBe(state)
  })

  it('updates only target placement while preserving the dragging id', () => {
    expect(
      applyWorktreeDropSnapshot(
        {
          draggingId: 'source',
          targetId: null,
          closestEdge: null,
        },
        {
          targetId: 'target',
          closestEdge: 'bottom',
        }
      )
    ).toEqual({
      draggingId: 'source',
      targetId: 'target',
      closestEdge: 'bottom',
    })
  })

  it('selects worktree drop targets by scope', () => {
    const dropTargets = [
      {
        data: {
          type: 'worktree-section',
          projectId: 'project',
          worktreeId: 'sidebar-target',
          scope: DRAG_SCOPE_WORKTREE_LIST,
        },
      },
      {
        data: {
          type: 'worktree-section',
          projectId: 'project',
          worktreeId: 'canvas-target',
          scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
        },
      },
    ]

    expect(
      getWorktreeDropTargetForScope(
        dropTargets,
        DRAG_SCOPE_CANVAS_WORKTREE_LIST
      )?.data.worktreeId
    ).toBe('canvas-target')
  })

  it('picks the canvas header of this project, not the sidebar or another project', () => {
    const header = (scope: string, projectId: string, groupId: string) => ({
      data: {
        type: DROP_TYPE_WORKTREE_GROUP_HEADER,
        projectId,
        groupId,
        scope,
      },
    })
    const dropTargets = [
      header(DRAG_SCOPE_WORKTREE_LIST, 'project', 'sidebar-group'),
      header(DRAG_SCOPE_CANVAS_WORKTREE_LIST, 'other', 'other-group'),
      header(DRAG_SCOPE_CANVAS_WORKTREE_LIST, 'project', 'canvas-group'),
    ]

    expect(
      getWorktreeListDropSnapshot(
        dropTargets,
        DRAG_SCOPE_CANVAS_WORKTREE_LIST,
        'project'
      )
    ).toEqual({
      targetId: 'canvas-group',
      closestEdge: null,
      kind: 'header',
      groupId: 'canvas-group',
    })
  })

  it('finds canvas headers only inside the canvas list (native fallback)', () => {
    document.body.innerHTML = `
      <div data-testid="sidebar">
        <div data-worktree-group-id="g1" data-worktree-group-project-id="project" data-worktree-group-scope="worktree-list"><span id="sidebar-name"></span></div>
      </div>
      <div data-testid="canvas-worktree-list">
        <div data-worktree-group-id="g1" data-worktree-group-project-id="other" data-worktree-group-scope="canvas-worktree-list"><span id="other-name"></span></div>
        <div data-worktree-group-id="g1" data-worktree-group-project-id="project" data-worktree-group-scope="canvas-worktree-list"><span id="canvas-name"></span></div>
      </div>`
    const container = document.querySelector<HTMLElement>(
      '[data-testid="canvas-worktree-list"]'
    )
    const find = (id: string) =>
      getWorktreeListElement({
        eventTarget: document.getElementById(id),
        container,
        scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
        projectId: 'project',
      })

    expect(find('sidebar-name')).toBeNull()
    expect(find('other-name')).toBeNull()
    const element = find('canvas-name')
    expect(element?.dataset.worktreeGroupProjectId).toBe('project')
    expect(
      getSnapshotFromWorktreeListElement({
        element,
        draggingId: 'w1',
        clientY: 0,
      })
    ).toMatchObject({ targetId: 'g1', kind: 'header', groupId: 'g1' })
    document.body.innerHTML = ''
  })
})
