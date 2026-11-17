import { memo, useCallback, useMemo } from 'react'
import { Bookmark } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getLabelTextColor } from '@/lib/label-colors'
import { getMarkedSessions } from '@/lib/marks'
import { cn } from '@/lib/utils'
import type { LabelData, Session } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'

const MAX_TOOLTIP_ROWS = 8

interface WorktreeMarkedSessionsBadgeProps {
  worktreeId: string
  worktreePath: string
  cards: readonly { session: Session; labels: LabelData[] }[] | undefined
  definitions: readonly MarkDefinition[]
  /** Mobile layout: icon and count only, no tooltip. */
  compact?: boolean
}

/**
 * Canvas worktree row badge: how many sessions in the worktree have marks.
 * The tooltip names each one with its marks; a click opens the first one.
 */
export const WorktreeMarkedSessionsBadge = memo(
  function WorktreeMarkedSessionsBadge({
    worktreeId,
    worktreePath,
    cards,
    definitions,
    compact = false,
  }: WorktreeMarkedSessionsBadgeProps) {
    const entries = useMemo(
      () => (cards ? getMarkedSessions(cards, definitions) : []),
      [cards, definitions]
    )
    const first = entries[0]
    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation()
        if (!first) return
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId: first.sessionId, worktreeId, worktreePath },
          })
        )
      },
      [first, worktreeId, worktreePath]
    )

    if (!first) return null

    // Entries and their marks list tracked marks first.
    const accent = first.marks[0]?.tracked ? first.marks[0].color : undefined
    const count = entries.length
    const button = (
      <button
        type="button"
        aria-label={`${count} marked session${count === 1 ? '' : 's'}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium tabular-nums',
          accent
            ? 'border-current'
            : 'border-border/50 text-muted-foreground hover:text-foreground',
          compact && '-my-1.5 py-1.5'
        )}
        style={accent ? { color: accent } : undefined}
        onClick={handleClick}
        onKeyDown={e => e.stopPropagation()}
      >
        <Bookmark className="size-3" />
        {count}
      </button>
    )

    if (compact) return button

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="max-w-80">
          <div className="flex flex-col gap-1">
            {entries.slice(0, MAX_TOOLTIP_ROWS).map(entry => (
              <div
                key={entry.sessionId}
                className="flex min-w-0 items-center gap-1.5"
              >
                <span className="min-w-0 truncate">{entry.name}</span>
                <span aria-hidden>—</span>
                <span className="flex shrink-0 items-center gap-1">
                  {entry.marks.map(mark => (
                    <span
                      key={mark.name}
                      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium"
                      style={{
                        backgroundColor: mark.color,
                        color: getLabelTextColor(mark.color),
                      }}
                    >
                      {mark.icon && <span className="mr-1">{mark.icon}</span>}
                      {mark.name}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            {count > MAX_TOOLTIP_ROWS && (
              <span className="opacity-70">
                +{count - MAX_TOOLTIP_ROWS} more
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }
)
