import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AllSessionsResponse,
  LabelData,
  Session,
  TrackedItemEntry,
} from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'
import { UnreadBell } from './UnreadBell'

const invokeMock = vi.fn()
const invokeForServerMock = vi.fn()
let allSessions: AllSessionsResponse | undefined
let allSessionsLoading = false
let allSessionsFetching = false
let unreadCount = 2
let unreadSessionsEnabled: boolean | undefined
let sendingSessionIds: Record<string, boolean> = {}
let trackedEntries: TrackedItemEntry[] = []
let marksLevel = 4
let sessionLabels: Record<string, LabelData[]> = {}
let sessionWorktreeMap: Record<string, string> = {}
const REVIEW_LATER: MarkDefinition = {
  name: 'Review later',
  color: '#3b82f6',
  icon: '🔖',
  tracked: true,
}
let markDefinitions: MarkDefinition[] = [
  { name: 'QA', color: '#22c55e', icon: null, tracked: false },
  REVIEW_LATER,
]

vi.mock('@/services/multi-server-sessions', () => ({
  useTrackedServerSources: () =>
    marksLevel >= 4 ? [{ serverId: 'local', name: 'Local', online: true }] : [],
  useConsolidatedTrackedItems: () =>
    useQuery({
      queryKey: ['all-sessions', 'tracked', 'test'],
      queryFn: () => ({ entries: [...trackedEntries] }),
    }),
}))

vi.mock('@/lib/marks-level', () => ({
  useMarksLevelLookup: () => () => marksLevel,
}))

vi.mock('@/lib/marks', async importOriginal => ({
  ...(await importOriginal()),
  useMarkDefinitionsByServer: () => () =>
    marksLevel >= 2 ? markDefinitions : [],
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  invokeForServer: (...args: unknown[]) => invokeForServerMock(...args),
}))

vi.mock('@/services/chat', () => ({
  chatQueryKeys: {
    unreadSessionCount: () => ['unread-session-count'],
  },
  useUnreadSessions: (enabled: boolean) => {
    unreadSessionsEnabled = enabled
    return {
      data: allSessions,
      isLoading: allSessionsLoading,
      isFetching: allSessionsFetching,
    }
  },
}))

let finishedSessionAnimationEnabled = true
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      finished_session_animation_enabled: finishedSessionAnimationEnabled,
    },
  }),
}))

vi.mock('./useUnreadCount', () => ({
  useUnreadCount: () => unreadCount,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean })
      .__JEAN_TEST_IS_MOBILE__ ?? false,
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal()),
  isNativeApp: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean })
      .__JEAN_TEST_IS_NATIVE__ ?? true,
}))

const selectProjectMock = vi.fn()
const selectWorktreeMock = vi.fn()
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({
      selectedProjectId: 'project-1',
      selectProject: selectProjectMock,
      selectWorktree: selectWorktreeMock,
    }),
  },
}))

const setActiveSessionMock = vi.fn()
const clearActiveWorktreeMock = vi.fn()
const setLastOpenedForProjectMock = vi.fn()
const setSessionLabelsMock = vi.fn()
vi.mock('@/store/chat-store', () => ({
  useChatStore: Object.assign(
    (
      selector: (state: {
        sendingSessionIds: Record<string, boolean>
      }) => unknown
    ) => selector({ sendingSessionIds }),
    {
      getState: () => ({
        setActiveSession: setActiveSessionMock,
        clearActiveWorktree: clearActiveWorktreeMock,
        setLastOpenedForProject: setLastOpenedForProjectMock,
        setSessionLabels: setSessionLabelsMock,
        sessionLabels,
        sessionWorktreeMap,
      }),
    }
  ),
}))

const markWorktreeForAutoOpenSessionMock = vi.fn()
const setRailSectionMock = vi.fn()
vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      markWorktreeForAutoOpenSession: markWorktreeForAutoOpenSessionMock,
      setRailSection: setRailSectionMock,
    }),
  },
}))

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    name: 'Session one',
    created_at: 1,
    updated_at: 2_000,
    last_opened_at: 1_000,
    messages: [],
    archived_at: null,
    backend: 'claude',
    backend_session_id: null,
    claude_session_id: null,
    codex_session_id: null,
    cursor_session_id: null,
    opencode_session_id: null,
    last_run_status: 'completed',
    waiting_for_input: false,
    waiting_for_input_type: null,
    is_reviewing: false,
    ...overrides,
  } as Session
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(children, {
    wrapper: ({ children: wrappedChildren }) => (
      <QueryClientProvider client={queryClient}>
        {wrappedChildren}
      </QueryClientProvider>
    ),
  })
}

async function openDropdown() {
  const user = userEvent.setup()
  renderWithQueryClient(<UnreadBell title="Jean" />)
  await user.click(screen.getByRole('button', { name: /2 finished sessions/i }))
  await screen.findByText('Session one')
  return user
}

describe('UnreadBell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean }
    ).__JEAN_TEST_IS_MOBILE__ = false
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = true
    unreadCount = 2
    allSessionsLoading = false
    allSessionsFetching = false
    sendingSessionIds = {}
    finishedSessionAnimationEnabled = true
    trackedEntries = []
    marksLevel = 4
    sessionLabels = {}
    sessionWorktreeMap = {}
    markDefinitions = [
      { name: 'QA', color: '#22c55e', icon: null, tracked: false },
      REVIEW_LATER,
    ]
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [
            session({
              id: 'session-1',
              name: 'Session one',
              updated_at: 2_000,
            }),
            session({
              id: 'session-2',
              name: 'Session two',
              updated_at: 1_900,
            }),
          ],
        },
      ],
    }
    invokeMock.mockResolvedValue(undefined)
    invokeForServerMock.mockResolvedValue(undefined)
  })

  it('loads the unread list before the popover opens while sessions are unread', () => {
    renderWithQueryClient(<UnreadBell title="Jean" />)
    expect(unreadSessionsEnabled).toBe(true)
  })

  it('does not load the unread list when nothing is unread', () => {
    unreadCount = 0
    renderWithQueryClient(<UnreadBell title="Jean" />)
    expect(unreadSessionsEnabled).toBe(false)
  })

  it('shows sessions that finish loading after the shortcut opens the popover', async () => {
    const loadedSessions = allSessions
    allSessions = undefined
    allSessionsLoading = true
    const view = renderWithQueryClient(<UnreadBell title="Jean" />)

    fireEvent(window, new CustomEvent('command:open-unread-sessions'))

    expect(
      screen.getByRole('button', { name: /2 finished sessions/i })
    ).toBeInTheDocument()
    allSessions = loadedSessions
    allSessionsLoading = false
    view.rerender(<UnreadBell title="Jean" />)

    expect(await screen.findByText('Session one')).toBeInTheDocument()
  })

  it('does not snapshot a stale empty list while the first open refetches', async () => {
    unreadCount = 1
    allSessions = { entries: [] }
    allSessionsFetching = true
    const view = renderWithQueryClient(<UnreadBell title="Jean" />)

    await userEvent.click(
      screen.getByRole('button', { name: /1 finished session/i })
    )

    expect(
      screen.getByRole('button', { name: /1 finished session/i })
    ).toBeInTheDocument()

    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-1', name: 'Session one' })],
        },
      ],
    }
    allSessionsFetching = false
    view.rerender(<UnreadBell title="Jean" />)

    expect(await screen.findByText('Session one')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /1 finished session/i })
    ).toBeInTheDocument()
  })

  it('shows a new finished session on the first open after the last one was read', async () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = false
    unreadCount = 1
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-1', name: 'Session one' })],
        },
      ],
    }
    const user = userEvent.setup()
    const view = renderWithQueryClient(<UnreadBell title="Jean" />)

    await user.click(
      screen.getByRole('button', { name: /1 finished session/i })
    )
    await user.click(screen.getByText('Session one'))
    await waitFor(() =>
      expect(screen.queryByText('Session one')).not.toBeInTheDocument()
    )

    unreadCount = 0
    allSessions = { entries: [] }
    view.rerender(<UnreadBell title="Jean" />)
    unreadCount = 1
    view.rerender(<UnreadBell title="Jean" />)

    await user.click(
      screen.getByRole('button', { name: /1 finished session/i })
    )
    expect(screen.queryByText('Session one')).not.toBeInTheDocument()

    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-2', name: 'Session two' })],
        },
      ],
    }
    view.rerender(<UnreadBell title="Jean" />)

    expect(await screen.findByText('Session two')).toBeInTheDocument()
  })

  it('shows the refetched session when the cached one was read elsewhere', async () => {
    unreadCount = 1
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-1', name: 'Session one' })],
        },
      ],
    }
    allSessionsFetching = true
    const view = renderWithQueryClient(<UnreadBell title="Jean" />)

    await userEvent.click(
      screen.getByRole('button', { name: /1 finished session/i })
    )

    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-2', name: 'Session two' })],
        },
      ],
    }
    allSessionsFetching = false
    view.rerender(<UnreadBell title="Jean" />)

    expect(await screen.findByText('Session two')).toBeInTheDocument()
    expect(screen.queryByText('No unread sessions')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /1 finished session/i })
    ).toBeInTheDocument()
  })

  it('shows cached unread sessions on the first click while refetching', async () => {
    allSessionsFetching = true
    renderWithQueryClient(<UnreadBell title="Jean" />)

    await userEvent.click(
      screen.getByRole('button', { name: /2 finished sessions/i })
    )

    expect(screen.getByText('Session one')).toBeInTheDocument()
    expect(screen.getByText('Session two')).toBeInTheDocument()
  })

  it('opens the list instead of selecting the only unread session from the bell', async () => {
    unreadCount = 1
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [session({ id: 'session-1', name: 'Session one' })],
        },
      ],
    }
    renderWithQueryClient(<UnreadBell title="Jean" />)

    await userEvent.click(
      screen.getByRole('button', { name: /1 finished session/i })
    )

    expect(screen.getByText('Session one')).toBeInTheDocument()
    expect(markWorktreeForAutoOpenSessionMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('Session one'))

    expect(markWorktreeForAutoOpenSessionMock).toHaveBeenCalledWith(
      'worktree-1',
      'session-1'
    )
    // Leaves the Agents page so the session opens in the Code view
    expect(setRailSectionMock).toHaveBeenCalledWith('workspace')
  })

  it('shows a running Claude session instead of stale waiting state', async () => {
    sendingSessionIds = { 'session-1': true }
    const firstEntry = allSessions?.entries[0]
    if (!firstEntry) throw new Error('Expected an unread session entry')
    firstEntry.sessions[0] = session({
      waiting_for_input: true,
      waiting_for_input_type: 'question',
      last_run_status: 'running',
    })

    await openDropdown()

    const row = screen.getByText('Session one').closest('[data-unread-index]')
    expect(row?.querySelector('svg')?.getAttribute('class') ?? '').toContain(
      'animate-spin'
    )
  })

  it('marks the focused unread session read when R is pressed', async () => {
    const user = await openDropdown()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('r')

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
        sessionId: 'session-2',
      })
    })
    expect(screen.queryByText('Session two')).not.toBeInTheDocument()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })

  it('marks all sessions read on their owning instances', async () => {
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          serverId: 'local',
          serverName: 'Local',
          sessions: [session({ id: 'session-1' })],
        },
        {
          project_id: 'remote-1:project-2',
          project_name: 'API',
          worktree_id: 'remote-1:worktree-2',
          worktree_name: 'feature',
          worktree_path: '/api',
          serverId: 'remote-1',
          serverName: 'Build box',
          sessions: [
            session({ id: 'remote-1:session-2', name: 'Remote session' }),
          ],
        },
      ],
    }

    const user = await openDropdown()
    await user.click(screen.getByRole('button', { name: 'Mark all read' }))

    await waitFor(() => {
      expect(invokeForServerMock).toHaveBeenCalledWith(
        'local',
        'set_session_last_opened',
        { sessionId: 'session-1' }
      )
      expect(invokeForServerMock).toHaveBeenCalledWith(
        'remote-1',
        'set_session_last_opened',
        { sessionId: 'session-2' }
      )
    })
  })

  it('shows an R keyboard affordance on the focused unread row', async () => {
    await openDropdown()

    const firstRow = screen
      .getByText('Session one')
      .closest('[data-unread-index]')
    const secondRow = screen
      .getByText('Session two')
      .closest('[data-unread-index]')

    if (!firstRow || !secondRow) {
      throw new Error('Expected both unread session rows to render')
    }

    expect(within(firstRow).getByText('R')).toBeInTheDocument()
    expect(within(secondRow).queryByText('R')).not.toBeInTheDocument()

    fireEvent.mouseEnter(secondRow)

    expect(within(secondRow).getByText('R')).toBeInTheDocument()
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()
  })

  it('shows the finished sessions shortcut hint while a modifier is held on native desktop', () => {
    renderWithQueryClient(<UnreadBell title="Jean" />)

    expect(
      screen
        .getByText(/(?:⌘|⌃|Ctrl) \+ ⇧|Shift \+ F/i)
        .closest('[data-mod-hint]')
    ).not.toBeNull()
  })

  it('uses a bell ring animation on the finished-sessions badge by default', () => {
    const { container } = renderWithQueryClient(<UnreadBell title="Jean" />)

    const bell = container.querySelector('svg')
    expect(bell?.getAttribute('class') ?? '').toContain('bell-ring')
    expect(container.querySelector('.finished-session-glow')).toBeNull()
    expect(container.querySelector('.card-border-spin')).toBeNull()
  })

  it('disables the finished-sessions animation when preference is off', () => {
    finishedSessionAnimationEnabled = false
    const { container } = renderWithQueryClient(<UnreadBell title="Jean" />)

    const bell = container.querySelector('svg')
    expect(bell?.getAttribute('class') ?? '').not.toContain('bell-ring')
    expect(container.querySelector('.finished-session-glow')).toBeNull()
    expect(container.querySelector('.card-border-spin')).toBeNull()
    expect(
      screen.getByRole('button', { name: /2 finished sessions/i })
    ).toBeInTheDocument()
  })

  it('hides unread keyboard affordances in web access', async () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = false

    const user = await openDropdown()

    expect(
      screen.queryByText(/(?:⌘|⌃|Ctrl) \+ (?:⇧|Shift) \+ F/i)
    ).not.toBeInTheDocument()

    const firstRow = screen
      .getByText('Session one')
      .closest('[data-unread-index]')
    if (!firstRow) throw new Error('Expected first unread session row')
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()

    await user.keyboard('r')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })

  it('hides unread keyboard affordances on mobile', async () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean }
    ).__JEAN_TEST_IS_MOBILE__ = true

    const user = await openDropdown()

    expect(
      screen.queryByText(/(?:⌘|⌃|Ctrl) \+ (?:⇧|Shift) \+ F/i)
    ).not.toBeInTheDocument()

    const firstRow = screen
      .getByText('Session one')
      .closest('[data-unread-index]')
    if (!firstRow) throw new Error('Expected first unread session row')
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()

    await user.keyboard('r')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })

  describe('tracked marks', () => {
    const reviewLater: LabelData = {
      name: 'Review later',
      color: '#3b82f6',
      added_at: 5,
    }

    function trackedSession(
      overrides: Partial<TrackedItemEntry> = {}
    ): TrackedItemEntry {
      return {
        kind: 'session',
        project_id: 'project-1',
        project_name: 'Jean',
        worktree_id: 'worktree-9',
        worktree_name: 'feature-x',
        worktree_path: '/repo-x',
        session: session({
          id: 'tracked-1',
          name: 'Tracked session',
          worktree_id: 'worktree-9',
        }),
        marks: [reviewLater],
        added_at: 5,
        ...overrides,
      }
    }

    const trackedWorktree: TrackedItemEntry = {
      kind: 'worktree',
      project_id: 'project-2',
      project_name: 'API',
      worktree_id: 'worktree-7',
      worktree_name: 'hotfix',
      worktree_path: '/api-hotfix',
      marks: [reviewLater],
      added_at: 4,
    }

    function row(text: string): HTMLElement {
      const element = screen.getByText(text).closest('[data-unread-index]')
      if (!(element instanceof HTMLElement)) throw new Error(`No row: ${text}`)
      return element
    }

    async function openTrackedTab() {
      const user = await openDropdown()
      await user.click(await screen.findByRole('button', { name: /^Tracked/ }))
      await screen.findByText('Tracked session')
      return user
    }

    it('shows Unread and Tracked tabs with their counts', async () => {
      trackedEntries = [trackedSession(), trackedWorktree]
      const user = await openDropdown()

      expect(
        screen.getByRole('button', { name: 'Unread (2)' })
      ).toHaveAttribute('aria-pressed', 'true')
      await user.click(
        await screen.findByRole('button', { name: 'Tracked (2)' })
      )

      expect(screen.getByText('Tracked session')).toBeInTheDocument()
      expect(screen.getByText('hotfix', { selector: '.truncate' }))
      expect(screen.queryByText('Session one')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Mark all read' })
      ).not.toBeInTheDocument()
    })

    it('shows the trigger with only tracked items and opens on Tracked', async () => {
      unreadCount = 0
      allSessions = { entries: [] }
      trackedEntries = [trackedSession(), trackedWorktree]
      const user = userEvent.setup()
      renderWithQueryClient(<UnreadBell title="Jean" />)

      const trigger = await screen.findByRole('button', { name: '2 tracked' })
      await user.click(trigger)

      expect(
        await screen.findByRole('button', { name: 'Tracked (2)' })
      ).toHaveAttribute('aria-pressed', 'true')
      expect(await screen.findByText('Tracked session')).toBeInTheDocument()
    })

    it('names finished and tracked counts in the trigger label', async () => {
      trackedEntries = [trackedSession()]
      renderWithQueryClient(<UnreadBell title="Jean" />)

      expect(
        await screen.findByRole('button', { name: '2 finished · 1 tracked' })
      ).toBeInTheDocument()
    })

    it('shows project and worktree on every row', async () => {
      trackedEntries = [trackedSession(), trackedWorktree]
      allSessions = {
        entries: [
          {
            project_id: 'remote-1:project-1',
            project_name: 'Jean',
            worktree_id: 'remote-1:worktree-1',
            worktree_name: 'main',
            worktree_path: '/repo',
            serverId: 'remote-1',
            serverName: 'Build box',
            sessions: [session({ id: 'remote-1:session-1' })],
          },
        ],
      }
      unreadCount = 1
      const user = userEvent.setup()
      renderWithQueryClient(<UnreadBell title="Jean" />)
      await user.click(
        await screen.findByRole('button', { name: /1 finished/ })
      )

      const unreadRow = row('Session one')
      expect(within(unreadRow).getByText('Jean')).toBeInTheDocument()
      expect(within(unreadRow).getByText('· main')).toBeInTheDocument()
      expect(within(unreadRow).getByText('· Build box')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /^Tracked/ }))
      const sessionRow = row('Tracked session')
      expect(within(sessionRow).getByText('Jean')).toBeInTheDocument()
      expect(within(sessionRow).getByText('· feature-x')).toBeInTheDocument()
      const worktreeRow = row('· hotfix')
      expect(within(worktreeRow).getByText('API')).toBeInTheDocument()
    })

    it('adds the first tracked mark with L and marks the session read', async () => {
      sessionWorktreeMap = { 'session-1': 'worktree-1' }
      sessionLabels = {
        'session-1': [{ name: 'QA', color: '#22c55e' }],
      }
      const user = await openDropdown()

      await user.keyboard('l')

      const next = [
        { name: 'QA', color: '#22c55e' },
        { name: 'Review later', color: '#3b82f6' },
      ]
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('update_session_state', {
          worktreeId: 'worktree-1',
          worktreePath: '/repo',
          sessionId: 'session-1',
          labels: next,
        })
        expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
          sessionId: 'session-1',
        })
      })
      expect(setSessionLabelsMock).toHaveBeenCalledWith('session-1', next)
      expect(screen.queryByText('Session one')).not.toBeInTheDocument()
    })

    it('marks read without a second mark when the session already has it', async () => {
      allSessions = {
        entries: [
          {
            project_id: 'project-1',
            project_name: 'Jean',
            worktree_id: 'worktree-1',
            worktree_name: 'main',
            worktree_path: '/repo',
            sessions: [
              session({
                id: 'session-1',
                name: 'Session one',
                labels: [reviewLater],
              }),
              session({ id: 'session-2', name: 'Session two' }),
            ],
          },
        ],
      }
      const user = await openDropdown()

      await user.click(
        within(row('Session one')).getByRole('button', {
          name: 'Review later',
        })
      )

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
          sessionId: 'session-1',
        })
      })
      expect(invokeMock).not.toHaveBeenCalledWith(
        'update_session_state',
        expect.anything()
      )
    })

    it('clears tracked marks with D and removes the row', async () => {
      trackedEntries = [trackedSession(), trackedWorktree]
      let finishClear: ((kept: LabelData[]) => void) | undefined
      invokeMock.mockImplementation((command: string) =>
        command === 'clear_tracked_marks'
          ? new Promise<LabelData[]>(resolve => {
              finishClear = resolve
            })
          : Promise.resolve(undefined)
      )
      const user = await openTrackedTab()

      await user.keyboard('d')

      expect(invokeMock).toHaveBeenCalledWith('clear_tracked_marks', {
        worktreeId: 'worktree-9',
        worktreePath: '/repo-x',
        sessionId: 'tracked-1',
      })
      // Removed at once, before the server answers.
      expect(screen.queryByText('Tracked session')).not.toBeInTheDocument()
      expect(screen.getByText('· hotfix')).toBeInTheDocument()
      trackedEntries = [trackedWorktree]
      finishClear?.([])
      await waitFor(() => {
        expect(screen.getByText('· hotfix')).toBeInTheDocument()
      })
      expect(screen.queryByText('Tracked session')).not.toBeInTheDocument()
    })

    it('clears a worktree with the Done button', async () => {
      trackedEntries = [trackedWorktree]
      unreadCount = 0
      allSessions = { entries: [] }
      invokeMock.mockImplementation(async (command: string) => {
        if (command !== 'clear_tracked_marks') return undefined
        trackedEntries = []
        return []
      })
      const user = userEvent.setup()
      renderWithQueryClient(<UnreadBell title="Jean" />)
      await user.click(await screen.findByRole('button', { name: '1 tracked' }))

      await user.click(
        within(row('· hotfix')).getByRole('button', { name: 'Done' })
      )

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('clear_tracked_marks', {
          worktreeId: 'worktree-7',
          worktreePath: '/api-hotfix',
          sessionId: undefined,
        })
      })
      expect(screen.queryByText('· hotfix')).not.toBeInTheDocument()
    })

    it('opens a tracked session without marking it read', async () => {
      trackedEntries = [trackedSession()]
      const user = await openTrackedTab()

      await user.click(screen.getByText('Tracked session'))

      expect(setActiveSessionMock).toHaveBeenCalledWith(
        'worktree-9',
        'tracked-1',
        { markOpened: false }
      )
      expect(markWorktreeForAutoOpenSessionMock).toHaveBeenCalledWith(
        'worktree-9',
        'tracked-1'
      )
      expect(invokeMock).not.toHaveBeenCalledWith(
        'set_session_last_opened',
        expect.anything()
      )
    })

    it('opens a tracked worktree on the canvas', async () => {
      trackedEntries = [trackedSession(), trackedWorktree]
      const user = await openTrackedTab()

      await user.click(
        within(row('· hotfix')).getByRole('button', { name: /hotfix/ })
      )

      expect(selectProjectMock).toHaveBeenCalledWith('project-2')
      expect(clearActiveWorktreeMock).toHaveBeenCalled()
      expect(selectWorktreeMock).toHaveBeenCalledWith('worktree-7')
      expect(markWorktreeForAutoOpenSessionMock).toHaveBeenCalledWith(
        'worktree-7'
      )
      expect(setRailSectionMock).toHaveBeenCalledWith('workspace')
    })

    it.each([
      ['web access', { native: false, mobile: false }],
      ['mobile', { native: true, mobile: true }],
    ])(
      'has no tracked keys or key hints in %s',
      async (_name, { native, mobile }) => {
        const testGlobals = globalThis as typeof globalThis & {
          __JEAN_TEST_IS_NATIVE__?: boolean
          __JEAN_TEST_IS_MOBILE__?: boolean
        }
        testGlobals.__JEAN_TEST_IS_NATIVE__ = native
        testGlobals.__JEAN_TEST_IS_MOBILE__ = mobile
        trackedEntries = [trackedSession()]
        const user = await openDropdown()

        await user.keyboard('l')
        expect(row('Session one').querySelector('kbd')).toBeNull()
        expect(
          within(row('Session one')).getByRole('button', {
            name: 'Review later',
          })
        ).not.toHaveClass('opacity-0')

        await user.click(screen.getByRole('button', { name: /^Tracked/ }))
        await screen.findByText('Tracked session')
        await user.keyboard('d')

        expect(document.querySelector('kbd')).toBeNull()
        expect(
          within(row('Tracked session')).getByRole('button', { name: 'Done' })
        ).not.toHaveClass('opacity-0')
        expect(invokeMock).not.toHaveBeenCalled()
      }
    )

    it('hides the tabs and Review later below marks level 4', async () => {
      marksLevel = 3
      trackedEntries = [trackedSession()]
      await openDropdown()

      expect(
        screen.queryByRole('button', { name: /^Tracked/ })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Review later' })
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: '2 finished sessions' })
      ).toBeInTheDocument()
    })
  })
})
