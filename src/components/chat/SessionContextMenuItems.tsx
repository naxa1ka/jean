import { toast } from 'sonner'
import {
  ArrowRight,
  Copy,
  Pencil,
  Play,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from '@/components/icons/reicon'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { copyToClipboard } from '@/lib/clipboard'
import {
  TRACKED_MARKS_LEVEL,
  toggleMark,
  useMarkDefinitions,
} from '@/lib/marks'
import { getResourceServerId, useServerMarksLevel } from '@/lib/marks-level'
import { canReconnectSession } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import type { LabelData, Session } from '@/types/chat'

const NO_LABELS: LabelData[] = []

interface SessionContextMenuItemsProps {
  session: Session
  /** Worktree of the session; selects the server whose mark list applies. */
  worktreeId: string
  resumeCommand: string | null
  nativeClientPending?: boolean
  onRename: () => void
  onToggleLabel: () => void
  onOpenInNativeClient?: () => void
  onReconnect?: () => void
  /** Tab bar only: close every other tab. Hidden when not given. */
  onCloseOtherTabs?: () => void
  /** Tab bar only: close the tabs after this one. Hidden when not given. */
  onCloseTabsToRight?: () => void
  onDelete: () => void
}

/**
 * Session right-click actions shared by the worktree tab bar and the sidebar
 * session rows. Keep this as the only item list so the two menus stay aligned.
 * The bulk tab-close items show only where the caller passes their handlers.
 */
export function SessionContextMenuItems({
  session,
  worktreeId,
  resumeCommand,
  nativeClientPending = false,
  onRename,
  onToggleLabel,
  onOpenInNativeClient,
  onReconnect,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onDelete,
}: SessionContextMenuItemsProps) {
  const serverId = getResourceServerId(worktreeId)
  const marksLevel = useServerMarksLevel(serverId)
  const definitions = useMarkDefinitions(serverId)
  const labels = useChatStore(
    state => state.sessionLabels[session.id] ?? NO_LABELS
  )
  const trackedDefinitions =
    marksLevel >= TRACKED_MARKS_LEVEL
      ? definitions.filter(definition => definition.tracked)
      : []

  return (
    <>
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="mr-2 h-4 w-4" />
        Rename
      </ContextMenuItem>
      {trackedDefinitions.map(definition => (
        <ContextMenuCheckboxItem
          key={definition.name}
          checked={labels.some(
            label => label.name.toLowerCase() === definition.name.toLowerCase()
          )}
          onSelect={() => {
            const { sessionLabels, setSessionLabels } = useChatStore.getState()
            setSessionLabels(
              session.id,
              toggleMark(sessionLabels[session.id] ?? NO_LABELS, definition)
            )
          }}
        >
          {definition.icon && <span aria-hidden>{definition.icon}</span>}
          {definition.name}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuItem onSelect={onToggleLabel}>
        <Tag className="mr-2 h-4 w-4" />
        Marks…
      </ContextMenuItem>
      {resumeCommand && onOpenInNativeClient && (
        <>
          <ContextMenuItem
            disabled={nativeClientPending}
            onSelect={onOpenInNativeClient}
          >
            <Play className="mr-2 h-4 w-4" />
            Open in Native Client
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void copyToClipboard(resumeCommand)
                .then(() => toast.success('Resume command copied'))
                .catch(() => toast.error('Failed to copy resume command'))
            }}
          >
            <Copy className="mr-2 h-4 w-4" />
            Native Resume Command
          </ContextMenuItem>
        </>
      )}
      {onReconnect && canReconnectSession(session) && (
        <ContextMenuItem onSelect={onReconnect}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Reconnect
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => {
          void copyToClipboard(session.id)
            .then(() => toast.success('Session ID copied'))
            .catch(() => toast.error('Failed to copy session ID'))
        }}
      >
        <Copy className="mr-2 h-4 w-4" />
        Copy Session ID
      </ContextMenuItem>
      {(onCloseOtherTabs || onCloseTabsToRight) && (
        <>
          <ContextMenuSeparator />
          {onCloseOtherTabs && (
            <ContextMenuItem onSelect={onCloseOtherTabs}>
              <X className="mr-2 h-4 w-4" />
              Close Other Tabs
            </ContextMenuItem>
          )}
          {onCloseTabsToRight && (
            <ContextMenuItem onSelect={onCloseTabsToRight}>
              <ArrowRight className="mr-2 h-4 w-4" />
              Close Tabs to the Right
            </ContextMenuItem>
          )}
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete Session
      </ContextMenuItem>
    </>
  )
}
