import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '@/store/projects-store'
import type { LabelData } from '@/types/chat'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeForServer: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
  invokeForServer: mocks.invokeForServer,
}))

import { countMarkUsage, removeMarkEverywhere, renameMark } from './marks'

const pin = (name: string): LabelData => ({
  name,
  color: '#ff0000',
  pinned: true,
})

const pinNames = (projectKey: string) =>
  useProjectsStore
    .getState()
    .projectCanvasSettings[projectKey]?.pinnedLabels?.map(label => label.name)

describe('marks services', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invokeForServer.mockReset()
    mocks.invoke.mockResolvedValue({ worktrees: 0, sessions: 1 })
    mocks.invokeForServer.mockResolvedValue({ worktrees: 2, sessions: 3 })
    useProjectsStore.setState({
      projectCanvasSettings: {
        'local-project': { pinnedLabels: [pin('Bug')] },
        'remote-1:project-a': { pinnedLabels: [pin('bug'), pin('Defect')] },
        'remote-1:project-b': { pinnedLabels: [pin('QA'), pin('Bug')] },
        'remote-2:project-c': { pinnedLabels: [pin('Bug')] },
      },
    })
  })

  it('renames on the server, then only the pins of that server', async () => {
    const usage = await renameMark('remote-1', 'Bug', ' Defect ')

    expect(mocks.invokeForServer).toHaveBeenCalledWith(
      'remote-1',
      'rename_mark',
      { oldName: 'Bug', newName: ' Defect ' }
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(usage).toEqual({ worktrees: 2, sessions: 3 })
    // A pin that already has the new name is not doubled.
    expect(pinNames('remote-1:project-a')).toEqual(['Defect'])
    expect(pinNames('remote-1:project-b')).toEqual(['QA', 'Defect'])
    expect(pinNames('remote-2:project-c')).toEqual(['Bug'])
    expect(pinNames('local-project')).toEqual(['Bug'])
  })

  it('removes on the local server, then only the local pins', async () => {
    await removeMarkEverywhere(undefined, 'BUG')

    expect(mocks.invoke).toHaveBeenCalledWith('remove_mark_everywhere', {
      name: 'BUG',
    })
    expect(pinNames('local-project')).toEqual([])
    expect(pinNames('remote-1:project-b')).toEqual(['QA', 'Bug'])
  })

  it('does not change pins when the server rejects a rename', async () => {
    mocks.invokeForServer.mockRejectedValue('A mark named QA already exists')

    await expect(renameMark('remote-1', 'Bug', 'QA')).rejects.toBe(
      'A mark named QA already exists'
    )
    expect(pinNames('remote-1:project-b')).toEqual(['QA', 'Bug'])
  })

  it('counts usage on the owning server', async () => {
    await countMarkUsage('remote-2', 'Bug')
    expect(mocks.invokeForServer).toHaveBeenCalledWith(
      'remote-2',
      'count_mark_usage',
      { name: 'Bug' }
    )
  })
})
