import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MarkDefinition } from '@/types/preferences'
import type * as MarksModule from '@/lib/marks'

const mocks = vi.hoisted(() => ({
  marksLevel: 1,
  definitions: [] as MarkDefinition[],
  definitionServerIds: [] as (string | undefined)[],
  mergeMarkDefinitions: vi.fn(),
}))

vi.mock('@/lib/marks-level', () => ({
  getResourceServerId: (id: string) =>
    id.includes(':') ? id.split(':')[0] : undefined,
  useServerMarksLevel: () => mocks.marksLevel,
}))

vi.mock('@/lib/marks', async importOriginal => ({
  ...(await importOriginal<typeof MarksModule>()),
  useMarkDefinitions: (serverId?: string) => {
    mocks.definitionServerIds.push(serverId)
    return mocks.marksLevel >= 2 ? mocks.definitions : []
  },
}))

vi.mock('@/services/marks', () => ({
  mergeMarkDefinitions: mocks.mergeMarkDefinitions,
}))

import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { NO_SESSION_LABELS, type LabelData } from '@/types/chat'
import { LabelModal } from './LabelModal'

const blocked = { name: 'Blocked', color: '#ef4444' }
const reviewLater: MarkDefinition = {
  name: 'Review later',
  color: '#3b82f6',
  icon: '🔖',
  tracked: true,
}
const needsTesting: MarkDefinition = {
  name: 'Needs testing',
  color: '#eab308',
  icon: null,
  tracked: false,
}

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

/** Visible row names of the picker list, in order. */
const rowNames = () =>
  screen
    .getAllByRole('button')
    .map(button => button.querySelector('.truncate')?.textContent)
    .filter(Boolean)

describe('LabelModal for a session', () => {
  beforeEach(() => {
    // `Blocked` is in use on another session, so the old-server picker lists it.
    useChatStore.setState({
      sessionLabels: { s2: [blocked] },
      sessionWorktreeMap: { s1: 'wt-1' },
    })
    mocks.definitions = [reviewLater, needsTesting]
    mocks.definitionServerIds = []
    mocks.mergeMarkDefinitions.mockReset()
    mocks.mergeMarkDefinitions.mockResolvedValue([])
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

  it('shows the server list in order, then the orphan marks of the item', () => {
    mocks.marksLevel = 2
    useChatStore.getState().setSessionLabels('s1', [blocked])
    render(<SessionPicker onClose={vi.fn()} />)

    expect(rowNames()).toEqual(['Review later', 'Needs testing', 'Blocked'])
    expect(screen.getByText('Not in list')).toBeInTheDocument()
    // Marks in use on other sessions are not listed when the server has a list.
    expect(screen.getAllByText('Blocked')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Add Blocked to list' }))
    expect(mocks.mergeMarkDefinitions).toHaveBeenCalledWith(undefined, [
      { name: 'Blocked', color: '#ef4444', icon: null, tracked: false },
    ])
  })

  it('applies a definition with the definition color', () => {
    mocks.marksLevel = 2
    render(<SessionPicker onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Review later'))
    expect(useChatStore.getState().sessionLabels.s1).toEqual([
      { name: 'Review later', color: '#3b82f6' },
    ])
  })

  it('"New mark" adds the definition to the server list, then applies it', async () => {
    mocks.marksLevel = 2
    let resolveMerge: (list: MarkDefinition[]) => void = () => undefined
    mocks.mergeMarkDefinitions.mockReturnValue(
      new Promise(resolve => {
        resolveMerge = resolve
      })
    )
    render(<SessionPicker onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('New mark…')
    fireEvent.change(input, { target: { value: ' QA ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Red' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(mocks.mergeMarkDefinitions).toHaveBeenCalledWith(undefined, [
      { name: 'QA', color: '#ef4444', icon: null, tracked: false },
    ])
    // Not applied before the server accepts the definition.
    expect(markNames()).toEqual([])

    resolveMerge([reviewLater, needsTesting])
    await waitFor(() => expect(markNames()).toEqual(['QA']))
  })

  it('does not apply a new mark when the server rejects it', async () => {
    mocks.marksLevel = 2
    mocks.mergeMarkDefinitions.mockRejectedValue('bad name')
    render(<SessionPicker onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText('New mark…')
    fireEvent.change(input, { target: { value: 'QA' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(mocks.mergeMarkDefinitions).toHaveBeenCalledTimes(1)
    )
    expect(markNames()).toEqual([])
  })

  it('uses the server of the session worktree', () => {
    mocks.marksLevel = 2
    useChatStore.setState({ sessionWorktreeMap: { s1: 'remote-1:wt-1' } })
    render(<SessionPicker onClose={vi.fn()} />)
    expect(mocks.definitionServerIds).toContain('remote-1')
  })
})

describe('LabelModal for a worktree', () => {
  beforeEach(() => {
    mocks.marksLevel = 2
    mocks.definitions = [reviewLater, needsTesting]
    useUIStore.setState({
      preferencesOpen: false,
      preferencesPane: null,
      preferencesTargetServerId: null,
    })
  })

  it('opens Settings → Marks for the item server from the pencil', () => {
    const onClose = vi.fn()
    render(
      <LabelModal
        isOpen
        onClose={onClose}
        sessionId={null}
        currentLabels={[]}
        target="worktree"
        serverId="remote-1"
        onApplyLabels={vi.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText('Edit Review later in Settings'))

    expect(onClose).toHaveBeenCalledTimes(1)
    const state = useUIStore.getState()
    expect(state.preferencesOpen).toBe(true)
    expect(state.preferencesPane).toBe('marks')
    expect(state.preferencesTargetServerId).toBe('remote-1')
  })

  it('keeps the pin state of the project pins', () => {
    const onApplyLabels = vi.fn<(labels: LabelData[]) => void>()
    render(
      <LabelModal
        isOpen
        onClose={vi.fn()}
        sessionId={null}
        currentLabels={[]}
        target="worktree"
        onApplyLabels={onApplyLabels}
        extraLabels={[
          { name: 'Needs testing', color: '#000000', pinned: true },
        ]}
      />
    )

    fireEvent.click(screen.getByText('Needs testing'))
    expect(onApplyLabels).toHaveBeenCalledWith([
      { name: 'Needs testing', color: '#eab308', pinned: true },
    ])
  })
})
