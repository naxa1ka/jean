import { describe, expect, it } from 'vitest'
import { CLIENT_MARKS_LEVEL, getMarksLevel } from './marks-level'

describe('getMarksLevel', () => {
  it('uses the client level for the local core', () => {
    expect(getMarksLevel({ isLocalBackend: true })).toBe(CLIENT_MARKS_LEVEL)
    expect(
      getMarksLevel({
        serverId: 'local',
        isLocalBackend: true,
        transportCapabilities: {},
      })
    ).toBe(CLIENT_MARKS_LEVEL)
  })

  it('reads the transport server in web access', () => {
    expect(
      getMarksLevel({
        isLocalBackend: false,
        transportCapabilities: { marks: 1 },
      })
    ).toBe(1)
    expect(
      getMarksLevel({ isLocalBackend: false, transportCapabilities: {} })
    ).toBe(0)
    expect(getMarksLevel({ isLocalBackend: false })).toBe(0)
  })

  it('reads the remote server snapshot for a remote server id', () => {
    expect(
      getMarksLevel({
        serverId: 'remote-a',
        isLocalBackend: true,
        transportCapabilities: { marks: 5 },
        remoteCapabilities: { marks: 1 },
      })
    ).toBe(1)
    expect(
      getMarksLevel({
        serverId: 'remote-a',
        isLocalBackend: true,
        remoteCapabilities: { multiServerTransport: 1 },
      })
    ).toBe(0)
    expect(getMarksLevel({ serverId: 'remote-a', isLocalBackend: true })).toBe(
      0
    )
  })
})
