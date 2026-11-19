import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type * as ProjectsService from '@/services/projects'
import type { JeanConfig } from '@/services/projects'
import { JeanJsonPane } from './JeanJsonPane'

const mutate = vi.fn()
let configResult: { data: JeanConfig | null | undefined; isLoading: boolean }

vi.mock('@/services/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsService>()),
  useJeanConfig: () => configResult,
  useSaveJeanConfig: () => ({ mutate, isPending: false }),
}))

const config: JeanConfig = {
  scripts: { setup: 'bun install', teardown: null, run: ['bun dev'] },
  ports: [{ port: 3000, label: 'Web' }],
  provider: { name: 'custom' } as unknown as JeanConfig['provider'],
}

function renderPane() {
  return render(<JeanJsonPane projectId="p1" projectPath="/repo" />)
}

describe('JeanJsonPane', () => {
  beforeEach(() => {
    mutate.mockReset()
    configResult = { data: config, isLoading: false }
  })

  it('fills the form from jean.json and keeps Save off until an edit', () => {
    renderPane()

    expect(screen.getByLabelText('Setup')).toHaveValue('bun install')
    expect(screen.getByDisplayValue('bun dev')).toBeInTheDocument()
    expect(screen.getByDisplayValue('3000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves edits and keeps fields the pane does not manage', () => {
    renderPane()

    fireEvent.change(screen.getByLabelText('Setup'), {
      target: { value: 'bun ci' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutate).toHaveBeenCalledWith({
      projectPath: '/repo',
      config: {
        scripts: {
          setup: 'bun ci',
          teardown: null,
          claim: null,
          run: 'bun dev',
        },
        ports: [{ port: 3000, label: 'Web', host: undefined }],
        provider: config.provider,
      },
    })
  })

  it('saves the claim script, and null when empty', () => {
    configResult = {
      data: { ...config, scripts: { ...config.scripts, claim: 'bun i' } },
      isLoading: false,
    }
    renderPane()
    const claim = screen.getByLabelText('Claim script')
    expect(claim).toHaveValue('bun i')

    fireEvent.change(claim, { target: { value: 'bun install' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(mutate.mock.lastCall?.[0].config.scripts.claim).toBe('bun install')

    fireEvent.change(claim, { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(mutate.mock.lastCall?.[0].config.scripts.claim).toBeNull()
  })

  it('shows the loaded config after the query finishes', () => {
    configResult = { data: undefined, isLoading: true }
    const { rerender } = renderPane()
    expect(screen.getByLabelText('Setup')).toHaveValue('')

    configResult = { data: config, isLoading: false }
    rerender(<JeanJsonPane projectId="p1" projectPath="/repo" />)

    expect(screen.getByLabelText('Setup')).toHaveValue('bun install')
  })
})
