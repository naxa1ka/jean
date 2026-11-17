import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Environment from '@/lib/environment'
import { invoke, invokeForServer } from '@/lib/transport'
import { preferencesQueryKeys } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { defaultPreferences } from '@/types/preferences'
import {
  groupClientMarksByServer,
  marksMergedFlagKey,
  useMarksClientMerge,
} from './useMarksClientMerge'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
  invokeForServer: vi.fn(),
}))
const env = vi.hoisted(() => ({
  isLocalBackend: true,
  snapshots: new Map<string, { status: string; capabilities: object }>(),
}))
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof Environment>()),
  isLocalBackend: () => env.isLocalBackend,
}))
vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () => env.snapshots,
}))
vi.mock('@/services/server-capabilities', () => ({
  useServerCapabilities: () => ({ data: undefined }),
}))

const red = { name: 'Bug', color: '#ff0000' }
const blue = { name: 'Later', color: '#0000ff' }
const asDefinition = (label: { name: string; color: string }) => ({
  ...label,
  icon: null,
  tracked: false,
})

function setCanvasSettings(
  settings: Record<string, { labels?: object[]; pinnedLabels?: object[] }>
) {
  useProjectsStore.setState({
    projectCanvasSettings: settings as never,
  })
}

function renderMerge(queryClient = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return {
    queryClient,
    ...renderHook(() => useMarksClientMerge(), { wrapper }),
  }
}

describe('groupClientMarksByServer', () => {
  it('groups local and remote keys by server', () => {
    const groups = groupClientMarksByServer({
      'project-1': { labels: [red], pinnedLabels: [blue] },
      'srv-a:project-2': { pinnedLabels: [red] },
      'srv-a:project-3': { labels: [blue] },
      'project-4': {},
    })
    expect([...groups.keys()]).toEqual(['local', 'srv-a'])
    expect(groups.get('local')).toEqual([red, blue].map(asDefinition))
    expect(groups.get('srv-a')).toEqual([red, blue].map(asDefinition))
  })
})

describe('useMarksClientMerge', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    // The global test setup stubs localStorage; back it with a real map here.
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
    env.isLocalBackend = true
    env.snapshots = new Map()
    setCanvasSettings({})
  })

  it('merges once per server and sets the flag', async () => {
    const list = [red, blue].map(asDefinition)
    vi.mocked(invoke).mockResolvedValue(list)
    vi.mocked(invokeForServer).mockResolvedValue(list)
    env.snapshots = new Map([
      ['srv-a', { status: 'online', capabilities: { marks: 2 } }],
    ])
    setCanvasSettings({
      'project-1': { labels: [red] },
      'srv-a:project-2': { pinnedLabels: [blue] },
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(preferencesQueryKeys.preferences('local'), {
      ...defaultPreferences,
    })

    const { rerender } = renderMerge(queryClient)
    await waitFor(() =>
      expect(localStorage.getItem(marksMergedFlagKey('srv-a'))).toBe('1')
    )
    expect(localStorage.getItem(marksMergedFlagKey('local'))).toBe('1')
    expect(invoke).toHaveBeenCalledWith('merge_mark_definitions', {
      definitions: [asDefinition(red)],
    })
    expect(invokeForServer).toHaveBeenCalledWith(
      'srv-a',
      'merge_mark_definitions',
      { definitions: [asDefinition(blue)] }
    )
    expect(
      queryClient.getQueryData<typeof defaultPreferences>(
        preferencesQueryKeys.preferences('local')
      )?.mark_definitions
    ).toEqual(list)

    // New labels later (store change) and a re-render do not merge again.
    act(() => setCanvasSettings({ 'project-1': { labels: [red, blue] } }))
    rerender()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invokeForServer).toHaveBeenCalledTimes(1)
  })

  it('skips servers below level 2 and offline servers', async () => {
    env.isLocalBackend = false // web access: transport capabilities are unknown
    env.snapshots = new Map([
      ['srv-old', { status: 'online', capabilities: { marks: 1 } }],
      ['srv-off', { status: 'offline', capabilities: { marks: 2 } }],
    ])
    setCanvasSettings({
      'project-1': { labels: [red] },
      'srv-old:p': { labels: [red] },
      'srv-off:p': { labels: [red] },
    })

    renderMerge()
    await act(() => Promise.resolve())
    expect(invoke).not.toHaveBeenCalled()
    expect(invokeForServer).not.toHaveBeenCalled()
    expect(storage.size).toBe(0)
  })

  it('does not set the flag on failure and retries on reconnect', async () => {
    vi.mocked(invokeForServer).mockRejectedValueOnce(new Error('boom'))
    env.snapshots = new Map([
      ['srv-a', { status: 'online', capabilities: { marks: 2 } }],
    ])
    setCanvasSettings({ 'srv-a:p': { labels: [red] } })

    const { rerender } = renderMerge()
    await waitFor(() => expect(invokeForServer).toHaveBeenCalledTimes(1))
    await act(() => Promise.resolve())
    expect(localStorage.getItem(marksMergedFlagKey('srv-a'))).toBeNull()

    vi.mocked(invokeForServer).mockResolvedValueOnce([asDefinition(red)])
    env.snapshots = new Map([
      ['srv-a', { status: 'online', capabilities: { marks: 2 } }],
    ])
    rerender()
    await waitFor(() =>
      expect(localStorage.getItem(marksMergedFlagKey('srv-a'))).toBe('1')
    )
    expect(invokeForServer).toHaveBeenCalledTimes(2)
  })
})
