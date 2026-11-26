import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { useProjectsStore } from '@/store/projects-store'
import { CanvasWorktreeGroupHeader } from './CanvasWorktreeGroupHeader'

describe('CanvasWorktreeGroupHeader', () => {
  const windowKeyDown = vi.fn()

  beforeEach(() => {
    useProjectsStore.setState({ collapsedWorktreeGroupKeys: new Set() })
    window.addEventListener('keydown', windowKeyDown)
  })

  afterEach(() => {
    window.removeEventListener('keydown', windowKeyDown)
    windowKeyDown.mockReset()
  })

  function renderHeader() {
    render(
      <CanvasWorktreeGroupHeader
        projectId="p1"
        groupId="g1"
        name="Alpha"
        collapseKey="g1"
        isCollapsed={false}
        count={2}
        status={null}
      />
    )
    return screen.getByRole('button', { name: 'Alpha group, 2 worktrees' })
  }

  it('toggles on Enter and keeps Enter from the canvas window handler', () => {
    fireEvent.keyDown(renderHeader(), { key: 'Enter' })

    expect(
      useProjectsStore.getState().collapsedWorktreeGroupKeys.has('g1')
    ).toBe(true)
    // useCanvasKeyboardNav opens the selected worktree on a window Enter.
    expect(windowKeyDown).not.toHaveBeenCalled()
  })

  it('toggles on Space and on click', () => {
    const header = renderHeader()
    fireEvent.keyDown(header, { key: ' ' })
    expect(
      useProjectsStore.getState().collapsedWorktreeGroupKeys.has('g1')
    ).toBe(true)
    fireEvent.click(header)
    expect(
      useProjectsStore.getState().collapsedWorktreeGroupKeys.has('g1')
    ).toBe(false)
  })
})
