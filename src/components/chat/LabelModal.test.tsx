import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ marksLevel: 1 }))

vi.mock('@/lib/marks-level', () => ({
  getResourceServerId: () => undefined,
  useServerMarksLevel: () => mocks.marksLevel,
}))

import { useChatStore } from '@/store/chat-store'
import { NO_SESSION_LABELS } from '@/types/chat'
import { LabelModal } from './LabelModal'

const blocked = { name: 'Blocked', color: '#ef4444' }

function SessionPicker({ onClose }: { onClose: () => void }) {
  const currentLabels = useChatStore(
    state => state.sessionLabels.s1 ?? NO_SESSION_LABELS
  )
  return (
    <LabelModal
      isOpen
      onClose={onClose}
      sessionId="s1"
      currentLabels={currentLabels}
    />
  )
}

const markNames = () =>
  (useChatStore.getState().sessionLabels.s1 ?? []).map(label => label.name)

describe('LabelModal for a session', () => {
  beforeEach(() => {
    // `Blocked` is in use on another session, so the picker lists it.
    useChatStore.setState({
      sessionLabels: { s2: [blocked] },
      sessionWorktreeMap: { s1: 'wt-1' },
    })
  })

  it('multi-selects marks at marks level 1 and stays open', () => {
    mocks.marksLevel = 1
    const onClose = vi.fn()
    render(<SessionPicker onClose={onClose} />)

    fireEvent.click(screen.getByText('Needs testing'))
    fireEvent.click(screen.getByText('Blocked'))
    expect(markNames()).toEqual(['Needs testing', 'Blocked'])
    expect(onClose).not.toHaveBeenCalled()

    // Clicking a selected mark removes only that mark.
    fireEvent.click(screen.getByText('Needs testing'))
    expect(markNames()).toEqual(['Blocked'])
  })

  it('clears all marks with Backspace', () => {
    mocks.marksLevel = 1
    useChatStore
      .getState()
      .setSessionLabels('s1', [
        { name: 'Needs testing', color: '#eab308' },
        blocked,
      ])
    render(<SessionPicker onClose={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Backspace' })
    expect('s1' in useChatStore.getState().sessionLabels).toBe(false)
  })

  it('single-selects and closes at marks level 0', () => {
    mocks.marksLevel = 0
    const onClose = vi.fn()
    render(<SessionPicker onClose={onClose} />)

    fireEvent.click(screen.getByText('Blocked'))
    expect(markNames()).toEqual(['Blocked'])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(/pin/i)).not.toBeInTheDocument()
  })
})
