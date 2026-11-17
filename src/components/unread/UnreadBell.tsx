import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  BellDot,
  Bookmark,
  BookmarkPlus,
  Loader2,
  CheckCircle2,
  CheckIcon,
  AlertTriangle,
  CirclePause,
  GitBranch,
  HelpCircle,
  FileText,
} from '@/components/icons/reicon'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SessionMarkChips } from '@/components/chat/SessionMarkChips'
import { cn } from '@/lib/utils'
import { invoke, invokeForServer } from '@/lib/transport'
import { parseServerResourceKey } from '@/lib/server-resource'
import {
  firstTrackedDefinition,
  TRACKED_MARKS_LEVEL,
  useMarkDefinitionsByServer,
} from '@/lib/marks'
import { useMarksLevelLookup } from '@/lib/marks-level'
import { useQueryClient } from '@tanstack/react-query'
import { chatQueryKeys, useUnreadSessions } from '@/services/chat'
import {
  useConsolidatedTrackedItems,
  useTrackedServerSources,
} from '@/services/multi-server-sessions'
import { usePreferences } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useUnreadCount } from './useUnreadCount'
import { formatShortcutDisplay } from '@/types/keybindings'
import {
  getSessionLabels,
  type LabelData,
  type Session,
  type TrackedItemEntry,
  type TrackedItemsResponse,
} from '@/types/chat'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import { isUnreadSession } from './unread-utils'

function formatRelativeTime(timestamp: number): string {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  const diffMs = Date.now() - ms
  if (diffMs < 0) return 'just now'
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (diffMs < hourMs)
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`
  return `${Math.floor(diffMs / dayMs)}d ago`
}

const UNREAD_LIST_QUERY_KEY = ['all-sessions', 'unread']
const TRACKED_LIST_QUERY_KEY = ['all-sessions', 'tracked']

type BellTab = 'unread' | 'tracked'

interface UnreadItem {
  session: Session
  projectId: string
  projectName: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
  serverId?: string
  serverName?: string
}

/** Stable key of a tracked row: the session id, or the worktree id. */
function trackedItemKey(item: TrackedItemEntry): string {
  return item.session
    ? `session:${item.session.id}`
    : `worktree:${item.worktree_id}`
}

/** Raw id on the owning server (the bell rows carry scoped ids for remote servers). */
function resourceIdOn(serverId: string | undefined, id: string): string {
  const parsed = parseServerResourceKey(id)
  return serverId && parsed?.serverId === serverId ? parsed.resourceId : id
}

function invokeOnServer<T>(
  serverId: string | undefined,
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  return serverId
    ? invokeForServer<T>(serverId, command, args)
    : invoke<T>(command, args)
}

function sessionItemOf(item: TrackedItemEntry, session: Session): UnreadItem {
  return {
    session,
    projectId: item.project_id,
    projectName: item.project_name,
    worktreeId: item.worktree_id,
    worktreeName: item.worktree_name,
    worktreePath: item.worktree_path,
    serverId: item.serverId,
    serverName: item.serverName,
  }
}

/** `project · worktree [· server]` line of every bell row. */
function RowContext({
  projectName,
  worktreeName,
  serverName,
}: {
  projectName: string
  worktreeName: string
  serverName?: string
}) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground/60">
      <span className="shrink-0 font-medium uppercase tracking-wider">
        {projectName}
      </span>
      <span className="truncate">· {worktreeName}</span>
      {serverName && <span className="truncate">· {serverName}</span>}
    </span>
  )
}

function getSessionStatus(session: Session, isSending: boolean) {
  // Prefer specific actionable reasons over generic waiting (matches canvas)
  const hasCodexPermission =
    (session.pending_codex_permission_requests?.length ?? 0) > 0 ||
    (session.pending_opencode_permission_requests?.length ?? 0) > 0 ||
    (session.pending_permission_denials?.length ?? 0) > 0
  const hasCodexCommand =
    (session.pending_codex_command_approval_requests?.length ?? 0) > 0
  const hasCodexUserInput =
    (session.pending_codex_user_input_requests?.length ?? 0) > 0
  const hasCodexMcp =
    (session.pending_codex_mcp_elicitation_requests?.length ?? 0) > 0
  const hasCodexTool =
    (session.pending_codex_dynamic_tool_call_requests?.length ?? 0) > 0

  if (hasCodexPermission) {
    return {
      icon: AlertTriangle,
      label: 'Permission required',
      className: 'text-warning',
    }
  }
  if (hasCodexCommand) {
    return {
      icon: AlertTriangle,
      label: 'Command approval required',
      className: 'text-warning',
    }
  }
  if (hasCodexTool) {
    return {
      icon: AlertTriangle,
      label: 'Tool approval required',
      className: 'text-warning',
    }
  }
  if (hasCodexMcp) {
    return {
      icon: HelpCircle,
      label: 'MCP input required',
      className: 'text-warning',
    }
  }
  if (hasCodexUserInput) {
    return {
      icon: HelpCircle,
      label: 'Input required',
      className: 'text-warning',
    }
  }
  if (isSending) {
    return {
      icon: Loader2,
      label: 'Running',
      className: 'text-foreground animate-spin dark:text-success',
    }
  }
  if (session.waiting_for_input) {
    const isPlan = session.waiting_for_input_type === 'plan'
    return {
      icon: isPlan ? FileText : HelpCircle,
      label: isPlan ? 'Plan approval required' : 'Input required',
      className: 'text-warning',
    }
  }
  if (session.scheduled_wakeup) {
    return {
      icon: CirclePause,
      label: 'Scheduled',
      className: 'text-info',
    }
  }
  const config: Record<
    string,
    { icon: typeof CheckCircle2; label: string; className: string }
  > = {
    completed: {
      icon: CheckCircle2,
      label: 'Completed',
      className: 'text-success',
    },
    cancelled: {
      icon: CirclePause,
      label: 'Cancelled',
      className: 'text-muted-foreground',
    },
    crashed: {
      icon: AlertTriangle,
      label: 'Crashed',
      className: 'text-destructive',
    },
  }
  if (session.last_run_status && config[session.last_run_status]) {
    return config[session.last_run_status]
  }
  return null
}

interface UnreadBellProps {
  title: string
  hideTitle?: boolean
}

/** Row action button (Review later, Done). Shown on hover/focus on desktop. */
function RowAction({
  label,
  onClick,
  alwaysVisible,
  children,
}: {
  label: string
  onClick: () => void
  alwaysVisible: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 cursor-pointer',
        !alwaysVisible && 'opacity-0 group-hover:opacity-100'
      )}
    >
      {children}
    </button>
  )
}

export function UnreadBell({ title, hideTitle }: UnreadBellProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<BellTab>('unread')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [snapshotItems, setSnapshotItems] = useState<UnreadItem[] | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const showDesktopKeyboardAffordances = isNativeApp() && !isMobile
  const queryClient = useQueryClient()
  const unreadCount = useUnreadCount()
  const { data: preferences } = usePreferences()
  const animationEnabled =
    preferences?.finished_session_animation_enabled ?? true
  // Keep the unread list warm while the badge shows, so opening the popover
  // renders rows at once instead of waiting for every server to answer.
  const {
    data: allSessions,
    isLoading,
    isFetching,
  } = useUnreadSessions(open || unreadCount > 0)
  // Tracked items drive the trigger too, so this query stays on while mounted.
  const trackedSupported = useTrackedServerSources().length > 0
  const { data: trackedData } = useConsolidatedTrackedItems(true)
  const trackedItems = useMemo(
    () => (trackedSupported ? (trackedData?.entries ?? []) : []),
    [trackedData, trackedSupported]
  )
  const trackedCount = trackedItems.length
  const marksLevel = useMarksLevelLookup()
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const activeTab: BellTab = trackedSupported ? tab : 'unread'

  // Open on Unread when it has items, else on Tracked.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next)
        setTab(unreadCount > 0 || trackedCount === 0 ? 'unread' : 'tracked')
      setOpen(next)
    },
    [trackedCount, unreadCount]
  )
  const handleOpenChangeRef = useRef(handleOpenChange)
  handleOpenChangeRef.current = handleOpenChange

  // Listen for command palette event to open the popover
  useEffect(() => {
    const handler = () => handleOpenChangeRef.current(true)
    window.addEventListener('command:open-unread-sessions', handler)
    return () =>
      window.removeEventListener('command:open-unread-sessions', handler)
  }, [])

  // Refresh the count and the list each time the popover opens. Cached rows
  // show meanwhile; cancelRefetch: false keeps an in-flight fetch going.
  useEffect(() => {
    if (open) {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.unreadSessionCount(),
      })
      void queryClient.refetchQueries(
        { queryKey: UNREAD_LIST_QUERY_KEY },
        { cancelRefetch: false }
      )
      void queryClient.refetchQueries(
        { queryKey: TRACKED_LIST_QUERY_KEY },
        { cancelRefetch: false }
      )
      setFocusedIndex(0)
    }
  }, [open, queryClient])

  // The badge count polls every server; refresh the warm list when it changes.
  useEffect(() => {
    if (unreadCount > 0) {
      void queryClient.refetchQueries(
        { queryKey: UNREAD_LIST_QUERY_KEY },
        { cancelRefetch: false }
      )
    }
  }, [unreadCount, queryClient])

  // Invalidate when any session is opened (so the count stays fresh)
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.unreadSessionCount(),
      })
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    }
    window.addEventListener('session-opened', handler)
    return () => window.removeEventListener('session-opened', handler)
  }, [queryClient])

  // Clear snapshot when popover fully closes
  useEffect(() => {
    if (!open) setSnapshotItems(null)
  }, [open])

  // Prune deleted sessions from the open snapshot. A session removed from the
  // live ['all-sessions'] data (closed/worktree deleted) is dropped,
  // while a row that merely flipped status stays present in `entries` — so this
  // does not reintroduce the mid-interaction yank the snapshot prevents.
  useEffect(() => {
    if (!open || !allSessions) return
    const liveIds = new Set(
      allSessions.entries.flatMap(e => e.sessions.map(s => s.id))
    )
    setSnapshotItems(prev =>
      prev ? prev.filter(item => liveIds.has(item.session.id)) : prev
    )
    // snapshotItems intentionally omitted to avoid a self-triggering loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions, open])

  const unreadItems = useMemo((): UnreadItem[] => {
    if (!allSessions) return []
    const results: UnreadItem[] = []
    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (isUnreadSession(session)) {
          results.push({
            session,
            projectId: entry.project_id,
            projectName: entry.project_name,
            worktreeId: entry.worktree_id,
            worktreeName: entry.worktree_name,
            worktreePath: entry.worktree_path,
            serverId: entry.serverId,
            serverName: entry.serverName,
          })
        }
      }
    }
    return results.sort((a, b) => b.session.updated_at - a.session.updated_at)
  }, [allSessions])

  // Freeze the list only after the open refetch is done. A snapshot of cached
  // rows can hold sessions read elsewhere; pruning them leaves an empty list.
  // A separate query supplies the badge count, so also wait until it agrees.
  useEffect(() => {
    if (
      !open ||
      !allSessions ||
      isFetching ||
      unreadItems.length === 0 ||
      unreadItems.length !== unreadCount
    )
      return
    setSnapshotItems(prev => prev ?? unreadItems)
  }, [allSessions, isFetching, open, unreadCount, unreadItems])

  // Items rendered inside the popover. While open, prefer the snapshot taken at
  // open time so a queued prompt restarting a session (status flip → unread=false)
  // does not yank items out from under the user mid-interaction.
  const displayItems = open && snapshotItems ? snapshotItems : unreadItems

  // Mark lists of every server with a row, for chips and "Review later".
  const rowServerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of displayItems) ids.add(item.serverId ?? LOCAL_SERVER_ID)
    for (const item of trackedItems) ids.add(item.serverId ?? LOCAL_SERVER_ID)
    return [...ids].sort()
  }, [displayItems, trackedItems])
  const rowServerKey = rowServerIds.join('|')
  // Same ids → same array, so the definitions lookup stays stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRowServerIds = useMemo(() => rowServerIds, [rowServerKey])
  const definitionsFor = useMarkDefinitionsByServer(stableRowServerIds)

  /** The "Review later" mark of an item's server, when that server supports it. */
  const reviewLaterMarkFor = useCallback(
    (serverId: string | undefined) =>
      marksLevel(serverId ?? LOCAL_SERVER_ID) >= TRACKED_MARKS_LEVEL
        ? firstTrackedDefinition(definitionsFor(serverId))
        : undefined,
    [definitionsFor, marksLevel]
  )

  const markSessionsReadOptimistically = useCallback(
    (sessionIds: string[]) => {
      const now = Math.floor(Date.now() / 1000)
      const sessionIdSet = new Set(sessionIds)
      queryClient.setQueriesData({ queryKey: ['all-sessions'] }, old => {
        if (!old) return old
        const data = old as { entries?: { sessions?: Session[] }[] }
        if (!data.entries) return old
        return {
          ...data,
          // Tracked entries have no `sessions` list; leave them as they are.
          entries: data.entries.map(entry =>
            entry.sessions
              ? {
                  ...entry,
                  sessions: entry.sessions.map(session =>
                    sessionIdSet.has(session.id)
                      ? { ...session, last_opened_at: now }
                      : session
                  ),
                }
              : entry
          ),
        }
      })
    },
    [queryClient]
  )

  const markSessionsOpened = useCallback(
    async (items: UnreadItem[]) => {
      const uniqueItems = items.filter(
        (item, index) =>
          item.session.id &&
          items.findIndex(other => other.session.id === item.session.id) ===
            index
      )
      const ids = uniqueItems.map(item => item.session.id)
      if (ids.length === 0) return

      const idSet = new Set(ids)
      setSnapshotItems(prev =>
        prev ? prev.filter(item => !idSet.has(item.session.id)) : prev
      )
      markSessionsReadOptimistically(ids)

      try {
        const groups = new Map<string, UnreadItem[]>()
        for (const item of uniqueItems) {
          const serverId = item.serverId ?? ''
          groups.set(serverId, [...(groups.get(serverId) ?? []), item])
        }
        await Promise.all(
          [...groups].map(async ([serverId, serverItems]) => {
            const resourceIds = serverItems.map(item =>
              resourceIdOn(serverId, item.session.id)
            )
            const command =
              resourceIds.length === 1
                ? 'set_session_last_opened'
                : 'set_sessions_last_opened_bulk'
            const args =
              resourceIds.length === 1
                ? { sessionId: resourceIds[0] }
                : { sessionIds: resourceIds }
            await invokeOnServer(serverId || undefined, command, args)
          })
        )
      } catch {
        // Cache invalidation below will reconcile optimistic state.
      } finally {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.unreadSessionCount(),
        })
        queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
        window.dispatchEvent(
          new CustomEvent('session-opened', { detail: { sessionIds: ids } })
        )
      }
    },
    [markSessionsReadOptimistically, queryClient]
  )

  const handleMarkAllRead = useCallback(async () => {
    await markSessionsOpened(displayItems)
  }, [displayItems, markSessionsOpened])

  const handleMarkOneRead = useCallback(
    async (item: UnreadItem) => {
      await markSessionsOpened([item])
      // Adjust focus: stay at same index or move up if at end
      setFocusedIndex(i => {
        const newTotal = displayItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
    },
    [displayItems.length, markSessionsOpened]
  )

  /** Add the first tracked mark ("Review later") and mark the session read. */
  const handleReviewLater = useCallback(
    async (item: UnreadItem) => {
      const mark = reviewLaterMarkFor(item.serverId)
      if (!mark) return
      const chat = useChatStore.getState()
      const current =
        chat.sessionLabels[item.session.id] ?? getSessionLabels(item.session)
      const key = mark.name.toLowerCase()
      if (!current.some(label => label.name.toLowerCase() === key)) {
        const next: LabelData[] = [
          ...current,
          { name: mark.name, color: mark.color },
        ]
        try {
          await invokeOnServer(item.serverId, 'update_session_state', {
            worktreeId: resourceIdOn(item.serverId, item.worktreeId),
            worktreePath: item.worktreePath,
            sessionId: resourceIdOn(item.serverId, item.session.id),
            labels: next,
          })
        } catch (error) {
          toast.error(`Failed to add ${mark.name}: ${error}`)
          return
        }
        if (chat.sessionWorktreeMap[item.session.id]) {
          chat.setSessionLabels(item.session.id, next)
        }
      }
      await handleMarkOneRead(item)
    },
    [handleMarkOneRead, reviewLaterMarkFor]
  )

  const handleSelect = useCallback(
    (item: UnreadItem, options: { markRead?: boolean } = {}) => {
      const { markRead = true } = options
      const { selectedProjectId, selectProject } = useProjectsStore.getState()
      const { setActiveSession, clearActiveWorktree, setLastOpenedForProject } =
        useChatStore.getState()

      if (selectedProjectId !== item.projectId) {
        selectProject(item.projectId)
      }

      // Navigate to ProjectCanvasView (no-op if already there)
      clearActiveWorktree()
      setActiveSession(item.worktreeId, item.session.id, {
        markOpened: false,
      })
      setLastOpenedForProject(item.projectId, item.worktreeId, item.session.id)

      // Queue auto-open via store so it survives lazy-mount + Suspense + remount.
      // ProjectCanvasView consumes pendingAutoOpenSessionIds in its own effect.
      const ui = useUIStore.getState()
      ui.markWorktreeForAutoOpenSession(item.worktreeId, item.session.id)
      // Leave the Agents page so the project canvas can open the session
      ui.setRailSection('workspace')

      // Mark read AFTER auto-open is queued so unreadCount->0 unmount can't race
      // the modal-open path. Bell popover closes via the unreadCount===0 check.
      if (markRead) void markSessionsOpened([item])
      setOpen(false)
    },
    [markSessionsOpened]
  )

  /** Open a tracked worktree on the project canvas. */
  const handleSelectWorktree = useCallback((item: TrackedItemEntry) => {
    const { selectedProjectId, selectProject, selectWorktree } =
      useProjectsStore.getState()
    if (selectedProjectId !== item.project_id) selectProject(item.project_id)
    useChatStore.getState().clearActiveWorktree()
    selectWorktree(item.worktree_id)
    const ui = useUIStore.getState()
    ui.markWorktreeForAutoOpenSession(item.worktree_id)
    ui.setRailSection('workspace')
    setOpen(false)
  }, [])

  const handleSelectTracked = useCallback(
    (item: TrackedItemEntry) => {
      if (item.session) {
        handleSelect(sessionItemOf(item, item.session), { markRead: false })
      } else {
        handleSelectWorktree(item)
      }
    },
    [handleSelect, handleSelectWorktree]
  )

  /** Done: clear the tracked marks of one item (untracked marks stay). */
  const handleDone = useCallback(
    async (item: TrackedItemEntry) => {
      const key = trackedItemKey(item)
      queryClient.setQueriesData<TrackedItemsResponse>(
        { queryKey: TRACKED_LIST_QUERY_KEY },
        old =>
          old
            ? {
                ...old,
                entries: old.entries.filter(
                  entry => trackedItemKey(entry) !== key
                ),
              }
            : old
      )
      setFocusedIndex(i => {
        const newTotal = trackedItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
      try {
        const kept = await invokeOnServer<LabelData[]>(
          item.serverId,
          'clear_tracked_marks',
          {
            worktreeId: resourceIdOn(item.serverId, item.worktree_id),
            worktreePath: item.worktree_path,
            sessionId: item.session
              ? resourceIdOn(item.serverId, item.session.id)
              : undefined,
          }
        )
        const chat = useChatStore.getState()
        if (item.session && chat.sessionWorktreeMap[item.session.id]) {
          chat.setSessionLabels(item.session.id, kept ?? [])
        }
        queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
      } catch (error) {
        toast.error(`Failed to clear marks: ${error}`)
        void queryClient.refetchQueries({ queryKey: TRACKED_LIST_QUERY_KEY })
      }
    },
    [queryClient, trackedItems.length]
  )

  const handleTabChange = useCallback((next: BellTab) => {
    setTab(next)
    setFocusedIndex(0)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total =
        activeTab === 'unread' ? displayItems.length : trackedItems.length
      if (!total) return
      const unreadItem =
        activeTab === 'unread' && focusedIndex >= 0
          ? displayItems[focusedIndex]
          : undefined
      const trackedItem =
        activeTab === 'tracked' && focusedIndex >= 0
          ? trackedItems[focusedIndex]
          : undefined

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex(i => (i < 0 ? 0 : Math.min(i + 1, total - 1)))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex(i => (i < 0 ? 0 : Math.max(i - 1, 0)))
          break
        case 'Enter':
          e.preventDefault()
          if (unreadItem) handleSelect(unreadItem)
          if (trackedItem) handleSelectTracked(trackedItem)
          break
        case 'Backspace':
        case 'r':
        case 'R':
          if (!showDesktopKeyboardAffordances || !unreadItem) break
          e.preventDefault()
          handleMarkOneRead(unreadItem)
          break
        case 'l':
        case 'L':
          if (!showDesktopKeyboardAffordances || !unreadItem) break
          e.preventDefault()
          void handleReviewLater(unreadItem)
          break
        case 'd':
        case 'D':
          if (!showDesktopKeyboardAffordances || !trackedItem) break
          e.preventDefault()
          void handleDone(trackedItem)
          break
      }
    },
    [
      activeTab,
      displayItems,
      trackedItems,
      focusedIndex,
      handleSelect,
      handleSelectTracked,
      handleMarkOneRead,
      handleReviewLater,
      handleDone,
      showDesktopKeyboardAffordances,
    ]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-unread-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  // Nothing unread or tracked → show normal title (or nothing if hideTitle).
  // Keep trigger mounted while popover is open so a queued prompt restarting a
  // session mid-interaction can't yank the trigger out and detach the popover.
  if (unreadCount === 0 && trackedCount === 0 && !open) {
    if (hideTitle) return null
    return (
      <span className="block truncate text-sm font-medium text-foreground/80">
        {title}
      </span>
    )
  }

  // Display count: prefer snapshot length while popover is open so the trigger
  // label matches what's actually shown inside the popover (and stays > 0 after
  // a status flip, until the user dismisses).
  const displayCount =
    open && snapshotItems ? snapshotItems.length : unreadCount
  const triggerLabel =
    [
      displayCount > 0 &&
        (trackedCount > 0
          ? `${displayCount} finished`
          : `${displayCount} finished ${displayCount === 1 ? 'session' : 'sessions'}`),
      trackedCount > 0 && `${trackedCount} tracked`,
    ]
      .filter(Boolean)
      .join(' · ') || 'No finished sessions'

  const hint = (focused: boolean, key: string, label: string) =>
    showDesktopKeyboardAffordances &&
    focused && (
      <Kbd title={label} className="-my-1">
        {key}
      </Kbd>
    )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={triggerLabel}
                className={cn(
                  'relative z-[1] flex items-center gap-1 truncate rounded-md bg-background px-1.5 text-sm font-medium cursor-pointer',
                  displayCount > 0 ? 'text-warning' : 'text-muted-foreground'
                )}
              >
                {displayCount > 0 && (
                  <>
                    <BellDot
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        animationEnabled &&
                          'animate-[bell-ring_2s_ease-in-out_infinite]'
                      )}
                    />
                    {displayCount}
                  </>
                )}
                {trackedCount > 0 && (
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <Bookmark className="h-3.5 w-3.5 shrink-0" />
                    {trackedCount}
                  </span>
                )}
                {showDesktopKeyboardAffordances && (
                  <Kbd modHint className="ml-1">
                    {formatShortcutDisplay('mod+shift+f')}
                  </Kbd>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{triggerLabel}</TooltipContent>
          </Tooltip>
        </div>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="center"
        sideOffset={6}
        collisionPadding={16}
        className={cn(
          'p-0',
          isMobile ? 'w-[calc(100vw-2rem)]' : 'w-[min(440px,calc(100vw-2rem))]'
        )}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={e => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
      >
        {(trackedSupported ||
          (activeTab === 'unread' && displayItems.length > 0)) && (
          <div className="flex items-center gap-2 px-2 py-1.5 border-b">
            {trackedSupported && (
              <SegmentedControl
                value={activeTab}
                onChange={handleTabChange}
                segments={[
                  {
                    value: 'unread',
                    label: `Unread (${displayItems.length})`,
                    icon: BellDot,
                  },
                  {
                    value: 'tracked',
                    label: `Tracked (${trackedCount})`,
                    icon: Bookmark,
                  },
                ]}
              />
            )}
            {/* Mark all read */}
            {activeTab === 'unread' && displayItems.length > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Mark all read
              </button>
            )}
          </div>
        )}

        {activeTab === 'tracked' ? (
          trackedItems.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-xs">
              No tracked items
            </div>
          ) : (
            <div className="max-h-[min(400px,60vh)] overflow-y-auto p-1">
              {trackedItems.map((item, idx) => {
                const focused = focusedIndex === idx
                return (
                  <div
                    key={trackedItemKey(item)}
                    data-unread-index={idx}
                    onMouseEnter={() => setFocusedIndex(idx)}
                    className={cn(
                      'group flex items-start gap-1 rounded-md transition-colors',
                      focused && 'bg-accent'
                    )}
                  >
                    <div
                      role="button"
                      tabIndex={-1}
                      onClick={() => handleSelectTracked(item)}
                      className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left cursor-pointer"
                    >
                      {item.session ? (
                        <Bookmark className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                      ) : (
                        <GitBranch className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <RowContext
                            projectName={item.project_name}
                            worktreeName={item.worktree_name}
                            serverName={item.serverName}
                          />
                          <span className="ml-auto shrink-0">
                            {hint(focused, 'D', 'Press D for Done')}
                          </span>
                        </div>
                        <span className="flex items-center gap-1.5 text-[13px]">
                          <span className="truncate">
                            {item.session?.name ?? item.worktree_name}
                          </span>
                          <SessionMarkChips
                            labels={item.marks}
                            definitions={definitionsFor(item.serverId)}
                          />
                        </span>
                      </div>
                    </div>
                    <RowAction
                      label="Done"
                      onClick={() => void handleDone(item)}
                      alwaysVisible={!showDesktopKeyboardAffordances || focused}
                    >
                      <CheckIcon className="h-3.5 w-3.5" />
                      Done
                    </RowAction>
                  </div>
                )
              })}
            </div>
          )
        ) : isLoading ||
          (isFetching && snapshotItems === null && unreadItems.length === 0) ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : displayItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-xs">
            No unread sessions
          </div>
        ) : (
          <div className="max-h-[min(400px,60vh)] overflow-y-auto p-1">
            {displayItems.map((item, idx) => {
              const status = getSessionStatus(
                item.session,
                sendingSessionIds[item.session.id] ?? false
              )
              const StatusIcon = status?.icon ?? CheckCircle2
              const focused = focusedIndex === idx
              const reviewLaterMark = reviewLaterMarkFor(item.serverId)

              return (
                <div
                  key={item.session.id}
                  data-unread-index={idx}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'group flex items-start gap-1 rounded-md transition-colors',
                    focused && 'bg-accent'
                  )}
                >
                  <div
                    role="button"
                    tabIndex={-1}
                    onClick={() => handleSelect(item)}
                    className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left cursor-pointer"
                  >
                    <StatusIcon
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 mt-0.5',
                        status?.className ?? 'text-muted-foreground'
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <RowContext
                          projectName={item.projectName}
                          worktreeName={item.worktreeName}
                          serverName={item.serverName}
                        />
                        <span className="text-2xs text-muted-foreground/40 shrink-0 ml-auto">
                          {formatRelativeTime(item.session.updated_at)}
                        </span>
                        {hint(focused, 'R', 'Press R to mark read')}
                        {reviewLaterMark &&
                          hint(
                            focused,
                            'L',
                            `Press L for ${reviewLaterMark.name}`
                          )}
                      </div>
                      <span className="text-[13px] truncate block">
                        {item.session.name}
                      </span>
                    </div>
                  </div>
                  {reviewLaterMark && (
                    <RowAction
                      label={reviewLaterMark.name}
                      onClick={() => void handleReviewLater(item)}
                      alwaysVisible={!showDesktopKeyboardAffordances || focused}
                    >
                      <BookmarkPlus className="h-3.5 w-3.5" />
                    </RowAction>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
