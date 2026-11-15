import { describe, expect, it } from 'vitest'
import type { PlanQueueSummary } from '@/types/plan-queue'
import { planQueueStatusText } from './plan-queue-utils'

const start = '2026-11-15T10:00:00Z'
const now = Date.parse(start) + 4 * 60 * 1000 + 10_000

function summary(patch: Partial<PlanQueueSummary> = {}): PlanQueueSummary {
  return {
    worktreeId: 'wt',
    pending: 2,
    doneCount: 2,
    total: 5,
    paused: false,
    blocked: false,
    ...patch,
  }
}

describe('planQueueStatusText', () => {
  it('shows position, plan name and elapsed time while running', () => {
    const s = summary({ runningPlan: '003-ui-check.md', runningSince: start })
    expect(planQueueStatusText(s, now)).toBe(
      'Queue 3/5 · running 003-ui-check · 4m'
    )
  })

  it('drops the elapsed part when the start time is missing', () => {
    const s = summary({ runningPlan: '003-ui-check.md' })
    expect(planQueueStatusText(s, now)).toBe('Queue 3/5 · running 003-ui-check')
  })

  it('shows paused, even while a plan runs', () => {
    const s = summary({ paused: true, runningPlan: '003-ui-check.md' })
    expect(planQueueStatusText(s, now)).toBe('Queue paused')
  })

  it('shows blocked first', () => {
    expect(
      planQueueStatusText(summary({ blocked: true, paused: true }), now)
    ).toBe('Queue blocked')
  })

  it('shows the wait reason when nothing runs', () => {
    const s = summary({ waitReason: 'session is busy' })
    expect(planQueueStatusText(s, now)).toBe('Queue waiting: session is busy')
  })

  it('shows the pending count when idle', () => {
    expect(planQueueStatusText(summary({ pending: 3 }), now)).toBe(
      'Queue 2/5 · 3 pending'
    )
  })

  it('shows done when no plan is left', () => {
    expect(
      planQueueStatusText(summary({ pending: 0, doneCount: 5 }), now)
    ).toBe('Queue 5/5 · done')
  })
})
