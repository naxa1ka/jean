import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreePrBadge } from './WorktreePrBadge'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openExternal,
}))

function renderBadge(
  worktree: Parameters<typeof WorktreePrBadge>[0]['worktree']
) {
  const onRowClick = vi.fn()
  render(
    <TooltipProvider>
      <div onClick={onRowClick} onKeyDown={onRowClick}>
        <WorktreePrBadge worktree={worktree} />
      </div>
    </TooltipProvider>
  )
  return { onRowClick }
}

describe('WorktreePrBadge', () => {
  it('opens the PR and does not activate the row', () => {
    const { onRowClick } = renderBadge({
      id: 'w1',
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
      cached_pr_status: 'open',
    })
    const button = screen.getByRole('button', { name: /PR #42/ })
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/42')
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('renders nothing without a linked PR URL', () => {
    renderBadge({ id: 'w1', pr_number: 42, pr_url: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })
})
