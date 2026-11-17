import { memo } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { LabelData } from '@/types/chat'

/** Color dots shown before the `+n` overflow count. */
const MAX_DOTS = 2

/**
 * Small mark chips after a session name: up to two color dots, then `+n`.
 * The tooltip lists all mark names. Renders nothing when there are no marks.
 */
export const SessionMarkChips = memo(function SessionMarkChips({
  labels,
}: {
  labels: LabelData[]
}) {
  if (labels.length === 0) return null
  const names = labels.map(label => label.name).join(', ')
  const overflow = labels.length - MAX_DOTS

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center gap-0.5"
          aria-label={`Marks: ${names}`}
        >
          {labels.slice(0, MAX_DOTS).map(label => (
            <span
              key={label.name}
              className="size-1.5 rounded-full"
              style={{ backgroundColor: label.color }}
            />
          ))}
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
