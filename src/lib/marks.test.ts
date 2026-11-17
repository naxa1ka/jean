import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { MarkDefinition } from '@/types/preferences'

const mocks = vi.hoisted(() => ({
  marksLevel: 2,
  preferences: undefined as { mark_definitions?: MarkDefinition[] } | undefined,
  preferencesServerIds: [] as (string | undefined)[],
}))

vi.mock('@/lib/marks-level', () => ({
  useServerMarksLevel: () => mocks.marksLevel,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: (serverId?: string) => {
    mocks.preferencesServerIds.push(serverId)
    return { data: mocks.preferences }
  },
}))

import { findDefinition, resolveMark, useMarkDefinitions } from './marks'

const reviewLater: MarkDefinition = {
  name: 'Review later',
  color: '#3b82f6',
  icon: '🔖',
  tracked: true,
}
const blocked: MarkDefinition = {
  name: 'Blocked',
  color: '#ef4444',
  icon: null,
  tracked: false,
}

describe('resolveMark', () => {
  it('uses the definition values, matched by name without case', () => {
    expect(
      resolveMark({ name: 'review LATER', color: '#000000' }, [
        blocked,
        reviewLater,
      ])
    ).toEqual({
      name: 'Review later',
      color: '#3b82f6',
      icon: '🔖',
      tracked: true,
      orphan: false,
    })
  })

  it('marks a label without a definition as an orphan with its own color', () => {
    expect(
      resolveMark({ name: 'Old', color: '#84cc16' }, [reviewLater])
    ).toEqual({
      name: 'Old',
      color: '#84cc16',
      icon: null,
      tracked: false,
      orphan: true,
    })
  })

  it('finds a definition by name without case', () => {
    expect(findDefinition('BLOCKED', [reviewLater, blocked])).toBe(blocked)
    expect(findDefinition('Missing', [reviewLater, blocked])).toBeUndefined()
  })
})

describe('useMarkDefinitions', () => {
  beforeEach(() => {
    mocks.marksLevel = 2
    mocks.preferences = { mark_definitions: [reviewLater, blocked] }
    mocks.preferencesServerIds = []
  })

  it('returns the server list at marks level 2', () => {
    const { result } = renderHook(() => useMarkDefinitions('remote-1'))
    expect(result.current).toEqual([reviewLater, blocked])
    expect(mocks.preferencesServerIds).toContain('remote-1')
  })

  it('reads the local server when no server is given', () => {
    renderHook(() => useMarkDefinitions())
    expect(mocks.preferencesServerIds).toContain('local')
  })

  it('returns an empty list below marks level 2', () => {
    mocks.marksLevel = 1
    const { result } = renderHook(() => useMarkDefinitions('remote-1'))
    expect(result.current).toEqual([])
  })
})
