import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import type { useWorktreeMenuActions } from './useWorktreeMenuActions'

const env = vi.hoisted(() => ({ isMobile: false, isTauri: false }))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => env.isMobile }))
vi.mock('@/services/projects', () => ({ isTauri: () => env.isTauri }))
vi.mock('@/lib/environment', () => ({
  canOpenInEditor: () => false,
  canOpenInFinder: () => false,
  canOpenInTerminal: () => false,
}))
vi.mock('./DeleteWorktreeDialog', () => ({ DeleteWorktreeDialog: () => null }))

const actions = {
  worktree: { id: 'wt-1', name: 'feature' } as Worktree,
  showDeleteConfirm: false,
  setShowDeleteConfirm: vi.fn(),
  isBase: true,
  runScripts: [],
  preferences: {},
  planQueueEnabled: false,
} as unknown as ReturnType<typeof useWorktreeMenuActions>

function openMenu(onSetMarks?: () => void) {
  render(
    <WorktreeContextMenu actions={actions} onSetMarks={onSetMarks}>
      <div>row</div>
    </WorktreeContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('row'))
}

describe('WorktreeContextMenu Marks…', () => {
  beforeEach(() => {
    env.isMobile = false
    env.isTauri = false
  })

  it('opens the picker from the native app', async () => {
    env.isTauri = true
    const onSetMarks = vi.fn()
    openMenu(onSetMarks)

    await userEvent.click(await screen.findByText('Marks…'))
    expect(onSetMarks).toHaveBeenCalledTimes(1)
  })

  it('shows on mobile', async () => {
    env.isMobile = true
    openMenu(vi.fn())
    expect(await screen.findByText('Marks…')).toBeInTheDocument()
  })

  it('hides in desktop web access', () => {
    openMenu(vi.fn())
    expect(screen.queryByText('Marks…')).not.toBeInTheDocument()
  })

  it('hides without a handler', () => {
    env.isTauri = true
    openMenu()
    expect(screen.queryByText('Marks…')).not.toBeInTheDocument()
  })
})
