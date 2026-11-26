import { describe, expect, it } from 'vitest'
import {
  CLIENT_WORKTREE_GROUPS_LEVEL,
  getWorktreeGroupsLevel,
} from './worktree-groups-level'

describe('getWorktreeGroupsLevel', () => {
  it('uses the client level for the local core', () => {
    expect(getWorktreeGroupsLevel({ isLocalBackend: true })).toBe(
      CLIENT_WORKTREE_GROUPS_LEVEL
    )
    expect(
      getWorktreeGroupsLevel({
        serverId: 'local',
        isLocalBackend: true,
        transportCapabilities: {},
      })
    ).toBe(CLIENT_WORKTREE_GROUPS_LEVEL)
  })

  it('reads the transport server in web access', () => {
    expect(
      getWorktreeGroupsLevel({
        isLocalBackend: false,
        transportCapabilities: { worktreeGroups: 1 },
      })
    ).toBe(1)
    expect(
      getWorktreeGroupsLevel({
        isLocalBackend: false,
        transportCapabilities: { marks: 4 },
      })
    ).toBe(0)
    expect(getWorktreeGroupsLevel({ isLocalBackend: false })).toBe(0)
  })

  it('reads the remote server snapshot for a remote server id', () => {
    expect(
      getWorktreeGroupsLevel({
        serverId: 'remote-a',
        isLocalBackend: true,
        transportCapabilities: { worktreeGroups: 1 },
        remoteCapabilities: { worktreeGroups: 1 },
      })
    ).toBe(1)
    expect(
      getWorktreeGroupsLevel({
        serverId: 'remote-a',
        isLocalBackend: true,
        transportCapabilities: { worktreeGroups: 1 },
        remoteCapabilities: { marks: 4 },
      })
    ).toBe(0)
    expect(
      getWorktreeGroupsLevel({ serverId: 'remote-a', isLocalBackend: true })
    ).toBe(0)
  })
})
