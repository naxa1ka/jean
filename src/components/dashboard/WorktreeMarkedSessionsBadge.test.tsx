import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { Session } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'
import { WorktreeMarkedSessionsBadge } from './WorktreeMarkedSessionsBadge'

const reviewLater: MarkDefinition = {
  name: 'Review later',
  color: '#3b82f6',
  icon: '🔖',
  tracked: true,
}

const card = (id: string, labels: { name: string; color: string }[]) => ({
  session: { id, name: `Session ${id}` } as Session,
  labels,
})

describe('WorktreeMarkedSessionsBadge', () => {
  it('renders nothing when no session has marks', () => {
    const { container } = render(
      <WorktreeMarkedSessionsBadge
        worktreeId="wt-1"
        worktreePath="/repo"
        cards={[card('a', [])]}
        definitions={[reviewLater]}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the first marked session on click without opening the row', async () => {
    const onOpen = vi.fn()
    const onRowClick = vi.fn()
    window.addEventListener('open-session-modal', onOpen)
    const user = userEvent.setup()
    render(
      <div onClick={onRowClick}>
        <WorktreeMarkedSessionsBadge
          worktreeId="wt-1"
          worktreePath="/repo"
          cards={[
            card('a', [{ name: 'Blocked', color: '#000' }]),
            card('b', [{ name: 'Review later', color: '#000' }]),
          ]}
          definitions={[reviewLater]}
          compact
        />
      </div>
    )
    await user.click(screen.getByRole('button', { name: '2 marked sessions' }))
    window.removeEventListener('open-session-modal', onOpen)

    expect(onRowClick).not.toHaveBeenCalled()
    expect((onOpen.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      sessionId: 'b',
      worktreeId: 'wt-1',
      worktreePath: '/repo',
    })
  })
})
