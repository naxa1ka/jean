import { memo } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { resolveMark } from '@/lib/marks'
import type { LabelData } from '@/types/chat'
import type { MarkDefinition } from '@/types/preferences'

/** Chips shown before the `+n` overflow count. */
const MAX_DOTS = 2

/**
 * Small mark chips after a session name: up to two chips (the icon of the
 * mark definition, else a color dot), then `+n`. The tooltip lists all mark
 * names. Renders nothing when there are no marks.
 */
export const SessionMarkChips = memo(function SessionMarkChips({
  labels,
  definitions,
}: {
  labels: LabelData[]
  /** Mark list of the session's server; the definition wins for color and icon. */
  definitions: readonly MarkDefinition[]
}) {
  if (labels.length === 0) return null
  const marks = labels.map(label => resolveMark(label, definitions))
  const names = marks.map(mark => mark.name).join(', ')
  const overflow = marks.length - MAX_DOTS

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center gap-0.5"
          aria-label={`Marks: ${names}`}
        >
          {marks.slice(0, MAX_DOTS).map(mark =>
            mark.icon ? (
              <span key={mark.name} className="text-2xs leading-none">
                {mark.icon}
              </span>
            ) : (
              <span
                key={mark.name}
                className="size-1.5 rounded-full"
                style={{ backgroundColor: mark.color }}
              />
            )
          )}
          {overflow > 0 && (
            <span className="text-2xs leading-none text-muted-foreground">
              +{overflow}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{names}</TooltipContent>
    </Tooltip>
  )
})
