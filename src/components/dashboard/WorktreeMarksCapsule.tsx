import { memo } from 'react'
import { SessionMarkChips } from '@/components/chat/SessionMarkChips'
import { getWorktreeLabels } from '@/lib/worktree-labels'
import type { MarkDefinition } from '@/types/preferences'
import type { Worktree } from '@/types/projects'

interface WorktreeMarksCapsuleProps {
  worktree: Pick<Worktree, 'labels' | 'label'>
  /** Mark list of the worktree's server; the definition wins for color and icon. */
  definitions: readonly MarkDefinition[]
}

/**
 * Sidebar row capsule for the worktree's own marks: up to two chips, then
 * `+n`. The tooltip lists all mark names. Renders nothing without marks.
 */
export const WorktreeMarksCapsule = memo(function WorktreeMarksCapsule({
  worktree,
  definitions,
}: WorktreeMarksCapsuleProps) {
  const labels = getWorktreeLabels(worktree)
  if (labels.length === 0) return null

  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-0.5">
      <SessionMarkChips labels={labels} definitions={definitions} />
    </span>
  )
})
