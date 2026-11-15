import { describe, expect, it } from 'vitest'
import { formatElapsed, isMarkdownFile, movePlan } from './plan-queue-utils'

describe('movePlan', () => {
  const names = ['001-a.md', '002-b.md', '003-c.md']

  it('moves a plan up and down', () => {
    expect(movePlan(names, 1, -1)).toEqual(['002-b.md', '001-a.md', '003-c.md'])
    expect(movePlan(names, 0, 2)).toEqual(['002-b.md', '003-c.md', '001-a.md'])
  })

  it('returns null past either end or for a no-op', () => {
    expect(movePlan(names, 0, -1)).toBeNull()
    expect(movePlan(names, 2, 1)).toBeNull()
    expect(movePlan(names, 1, 0)).toBeNull()
    expect(movePlan(names, 5, -1)).toBeNull()
  })

  it('does not change the input', () => {
    movePlan(names, 0, 1)
    expect(names).toEqual(['001-a.md', '002-b.md', '003-c.md'])
  })
})

describe('formatElapsed', () => {
  const start = '2026-11-15T10:00:00Z'
  const at = (s: number) => Date.parse(start) + s * 1000

  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(start, at(45))).toBe('45s')
    expect(formatElapsed(start, at(4 * 60 + 10))).toBe('4m')
    expect(formatElapsed(start, at(2 * 3600 + 5 * 60))).toBe('2h 5m')
    expect(formatElapsed(start, at(3600))).toBe('1h')
  })

  it('is empty for a missing or bad date, and never negative', () => {
    expect(formatElapsed(undefined, at(0))).toBe('')
    expect(formatElapsed('nope', at(0))).toBe('')
    expect(formatElapsed(start, at(-30))).toBe('0s')
  })
})

describe('isMarkdownFile', () => {
  it('accepts .md in any case only', () => {
    expect(isMarkdownFile({ name: 'plan.MD' })).toBe(true)
    expect(isMarkdownFile({ name: 'plan.txt' })).toBe(false)
  })
})
