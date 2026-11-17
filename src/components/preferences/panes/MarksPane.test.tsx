import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { SettingsTargetProvider } from '@/lib/settings-target'
import type { MarkDefinition } from '@/types/preferences'

const mocks = vi.hoisted(() => ({
  marksLevel: 2,
  definitions: [] as MarkDefinition[],
  setMarkDefinitions: vi.fn(),
  toastError: vi.fn(),
  levelServerIds: [] as (string | undefined)[],
}))

vi.mock('@/lib/marks-level', () => ({
  useServerMarksLevel: (serverId?: string) => {
    mocks.levelServerIds.push(serverId)
    return mocks.marksLevel
  },
}))

vi.mock('@/lib/marks', () => ({
  MARK_LIST_LEVEL: 2,
  useMarkDefinitions: () => mocks.definitions,
}))

vi.mock('@/services/marks', () => ({
  setMarkDefinitions: mocks.setMarkDefinitions,
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}))

import { MarksPane } from './MarksPane'

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

function renderPane(serverId = 'remote-1') {
  return render(
    <SettingsTargetProvider serverId={serverId}>
      <MarksPane />
    </SettingsTargetProvider>
  )
}

const savedList = () =>
  mocks.setMarkDefinitions.mock.calls.at(-1) as [string, MarkDefinition[]]

describe('MarksPane', () => {
  beforeEach(() => {
    mocks.marksLevel = 2
    mocks.definitions = [reviewLater, needsTesting]
    mocks.setMarkDefinitions.mockReset()
    mocks.setMarkDefinitions.mockResolvedValue([])
    mocks.toastError.mockReset()
    mocks.levelServerIds = []
  })

  it('shows a message instead of the list below marks level 2', () => {
    mocks.marksLevel = 1
    renderPane()
    expect(
      screen.getByText('This server does not support marks yet.')
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Mark list')).not.toBeInTheDocument()
  })

  it('edits the list of the Settings target server', () => {
    renderPane('remote-1')
    expect(mocks.levelServerIds).toContain('remote-1')
    fireEvent.click(
      screen.getByRole('button', { name: 'Move Needs testing up' })
    )
    expect(savedList()[0]).toBe('remote-1')
  })

  it('adds a mark at the end of the list', async () => {
    renderPane()
    fireEvent.change(screen.getByLabelText('New mark name'), {
      target: { value: ' QA ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add mark' }))

    expect(savedList()[1]).toEqual([
      reviewLater,
      needsTesting,
      { name: 'QA', color: '#eab308', icon: null, tracked: false },
    ])
    await waitFor(() =>
      expect(screen.getByLabelText('New mark name')).toHaveValue('')
    )
  })

  it('reorders marks with the up and down buttons', () => {
    renderPane()
    expect(
      screen.getByRole('button', { name: 'Move Review later up' })
    ).toBeDisabled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Move Review later down' })
    )
    expect(savedList()[1]).toEqual([needsTesting, reviewLater])
  })

  it('removes a mark from the list', () => {
    renderPane()
    const buttons = screen.getAllByRole('button', { name: 'Remove from list' })
    fireEvent.click(buttons[0] as HTMLElement)
    expect(savedList()[1]).toEqual([needsTesting])
  })

  it('turns "Track in bell" on for one mark', () => {
    renderPane()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Track Needs testing in bell' })
    )
    expect(savedList()[1]).toEqual([
      reviewLater,
      { ...needsTesting, tracked: true },
    ])
  })

  it('renames on Enter and shows a server error as a toast', async () => {
    mocks.setMarkDefinitions.mockRejectedValue(
      "Mark 'Review later' is in the list more than once"
    )
    renderPane()
    const input = screen.getByLabelText('Name of Needs testing')
    fireEvent.change(input, { target: { value: 'Review later' } })
    fireEvent.blur(input)

    expect(savedList()[1]).toEqual([
      reviewLater,
      { ...needsTesting, name: 'Review later' },
    ])
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Failed to save marks: Mark 'Review later' is in the list more than once"
      )
    )
    await waitFor(() => expect(input).toHaveValue('Needs testing'))
  })

  it('saves an emoji icon, and an empty icon as none', () => {
    renderPane()
    const icon = screen.getByLabelText('Icon of Review later')
    fireEvent.change(icon, { target: { value: '' } })
    fireEvent.blur(icon)
    expect(savedList()[1]).toEqual([
      { ...reviewLater, icon: null },
      needsTesting,
    ])
  })
})
