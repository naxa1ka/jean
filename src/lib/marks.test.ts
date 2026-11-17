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

import {
  findDefinition,
  getMarkedSessions,
  resolveMark,
  toggleMark,
  useMarkDefinitions,
} from './marks'

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

describe('getMarkedSessions', () => {
  const card = (
    id: string,
    labels: { name: string; color: string; added_at?: number }[],
    archived_at?: number
  ) => ({ session: { id, name: `Session ${id}`, archived_at }, labels })

  it('returns an empty list when no session has marks', () => {
    expect(getMarkedSessions([], [reviewLater])).toEqual([])
    expect(getMarkedSessions([card('a', [])], [reviewLater])).toEqual([])
  })

  it('leaves out archived sessions', () => {
    const result = getMarkedSessions(
      [
        card('a', [{ name: 'Blocked', color: '#000' }], 123),
        card('b', [{ name: 'Blocked', color: '#000' }]),
      ],
      [blocked]
    )
    expect(result.map(entry => entry.sessionId)).toEqual(['b'])
  })

  it('puts tracked sessions first, then the newest mark', () => {
    const result = getMarkedSessions(
      [
        card('old', [{ name: 'Blocked', color: '#000', added_at: 1 }]),
        card('new', [{ name: 'Blocked', color: '#000', added_at: 9 }]),
        card('tracked', [
          { name: 'Blocked', color: '#000', added_at: 5 },
          { name: 'review later', color: '#000', added_at: 2 },
        ]),
        card('none', [{ name: 'Blocked', color: '#000' }]),
      ],
      [reviewLater, blocked]
    )
    expect(result.map(entry => entry.sessionId)).toEqual([
      'tracked',
      'new',
      'old',
      'none',
    ])
    expect(result[0]?.name).toBe('Session tracked')
    expect(result[0]?.marks.map(mark => mark.name)).toEqual([
      'Review later',
      'Blocked',
    ])
  })
})

describe('toggleMark', () => {
  it('adds the mark and keeps the others with their added_at', () => {
    expect(
      toggleMark([{ name: 'Blocked', color: '#000', added_at: 4 }], reviewLater)
    ).toEqual([
      { name: 'Blocked', color: '#000', added_at: 4 },
      { name: 'Review later', color: '#3b82f6' },
    ])
  })

  it('removes only that mark, matched without case', () => {
    expect(
      toggleMark(
        [
          { name: 'review later', color: '#000', added_at: 1 },
          { name: 'Blocked', color: '#000', added_at: 4 },
        ],
        reviewLater
      )
    ).toEqual([{ name: 'Blocked', color: '#000', added_at: 4 }])
  })
})
