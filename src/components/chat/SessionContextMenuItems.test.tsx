import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Session } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'
import { useChatStore } from '@/store/chat-store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { SessionContextMenuItems } from './SessionContextMenuItems'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  canReconnectSession: vi.fn(() => false),
  marksLevel: 0,
  definitions: [] as MarkDefinition[],
}))

vi.mock('@/lib/marks-level', () => ({
  getResourceServerId: () => undefined,
  useServerMarksLevel: () => mocks.marksLevel,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { mark_definitions: mocks.definitions } }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('@/services/chat', () => ({
  canReconnectSession: mocks.canReconnectSession,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const session = {
  id: 'session-1',
  name: 'Session 2',
  order: 0,
  created_at: 0,
  updated_at: 0,
  messages: [],
} as Session

function renderMenu(
  props: Partial<React.ComponentProps<typeof SessionContextMenuItems>> = {}
) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Session 2</ContextMenuTrigger>
      <ContextMenuContent>
        <SessionContextMenuItems
          session={session}
          worktreeId="worktree-1"
          resumeCommand={null}
          onRename={vi.fn()}
          onToggleLabel={vi.fn()}
          onDelete={vi.fn()}
          {...props}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('Session 2'))
}

describe('SessionContextMenuItems', () => {
  beforeEach(() => {
    mocks.copyToClipboard.mockReset()
    mocks.copyToClipboard.mockResolvedValue(undefined)
    mocks.canReconnectSession.mockReturnValue(false)
    mocks.marksLevel = 0
    mocks.definitions = []
    useChatStore.setState({ sessionLabels: {} })
  })

  it('lists the same actions as the worktree session tab menu', () => {
    renderMenu()

    const labels = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(labels).toEqual([
      'Rename',
      'Marks…',
      'Copy Session ID',
      'Delete Session',
    ])
  })

  it('adds native-client and reconnect actions when the session supports them', () => {
    mocks.canReconnectSession.mockReturnValue(true)
    renderMenu({
      resumeCommand: 'codex resume thread-1',
      onOpenInNativeClient: vi.fn(),
      onReconnect: vi.fn(),
    })

    const labels = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(labels).toEqual([
      'Rename',
      'Marks…',
      'Open in Native Client',
      'Native Resume Command',
      'Reconnect',
      'Copy Session ID',
      'Delete Session',
    ])
  })

  it('is the menu used by both the tab bar and the sidebar', () => {
    for (const path of [
      'src/components/chat/SessionChatModal.tsx',
      'src/components/projects/SidebarSessionContextMenu.tsx',
    ]) {
      expect(readFileSync(path, 'utf8')).toContain('<SessionContextMenuItems')
    }
  })

  it('copies the session id', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('menuitem', { name: 'Copy Session ID' }))
    expect(mocks.copyToClipboard).toHaveBeenCalledWith('session-1')
  })

  describe('tracked-mark toggles', () => {
    const reviewLater: MarkDefinition = {
      name: 'Review later',
      color: '#3b82f6',
      icon: '🔖',
      tracked: true,
    }
    const blocked: MarkDefinition = {
      name: 'Blocked',
      color: '#ef4444',
      icon: null,
      tracked: false,
    }

    beforeEach(() => {
      mocks.definitions = [reviewLater, blocked]
    })

    it('lists one toggle per tracked mark above Marks… at level 4', () => {
      mocks.marksLevel = 4
      renderMenu()
      expect(
        screen.getAllByRole('menuitemcheckbox').map(item => item.textContent)
      ).toEqual(['🔖Review later'])
      expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute(
        'aria-checked',
        'false'
      )
    })

    it('hides the toggles below level 4', () => {
      mocks.marksLevel = 3
      renderMenu()
      expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument()
    })

    it('adds the mark and keeps the other marks', async () => {
      mocks.marksLevel = 4
      useChatStore.setState({
        sessionLabels: {
          'session-1': [{ name: 'Blocked', color: '#ef4444', added_at: 3 }],
        },
      })
      const user = userEvent.setup()
      renderMenu()
      await user.click(screen.getByRole('menuitemcheckbox'))
      expect(useChatStore.getState().sessionLabels['session-1']).toEqual([
        { name: 'Blocked', color: '#ef4444', added_at: 3 },
        { name: 'Review later', color: '#3b82f6' },
      ])
    })

    it('removes only that mark when it is checked', async () => {
      mocks.marksLevel = 4
      useChatStore.setState({
        sessionLabels: {
          'session-1': [
            { name: 'Review later', color: '#3b82f6', added_at: 1 },
            { name: 'Blocked', color: '#ef4444', added_at: 3 },
          ],
        },
      })
      const user = userEvent.setup()
      renderMenu()
      expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await user.click(screen.getByRole('menuitemcheckbox'))
      expect(useChatStore.getState().sessionLabels['session-1']).toEqual([
        { name: 'Blocked', color: '#ef4444', added_at: 3 },
      ])
    })
  })
})
