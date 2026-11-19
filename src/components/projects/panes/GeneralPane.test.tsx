import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralPane } from './GeneralPane'

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  installedBackends: [] as string[],
  updateSettings: vi.fn(),
  preferences: {} as Record<string, unknown>,
}))

vi.mock('@/lib/transport', () => ({
  convertServerFileSrc: (serverId: string | undefined, path: string) =>
    serverId ? `remote:${serverId}:${path}` : `file://${path}`,
  convertProjectFileSrc: (serverId: string | undefined, path: string) =>
    serverId ? `remote-project:${serverId}:${path}` : `project://${path}`,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: mocks.projects }),
  useProjectBranches: () => ({ data: [], isLoading: false, error: null }),
  useUpdateProjectSettings: () => ({
    mutate: mocks.updateSettings,
    isPending: false,
  }),
  useAppDataDir: () => ({ data: '/app-data' }),
  useSetProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
  useWorktreePoolStatus: () => ({ data: { idle: 1, filling: 2 } }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mocks.preferences }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: mocks.installedBackends }),
}))

function project(avatarPath: string): Project {
  return {
    id: 'project-1',
    name: 'Jean',
    path: '/projects/jean',
    default_branch: 'main',
    added_at: 1,
    order: 0,
    avatar_path: avatarPath,
  }
}

describe('GeneralPane project avatar', () => {
  beforeEach(() => {
    mocks.projects = [project('avatars/project-1-old.png')]
    mocks.installedBackends = []
    mocks.updateSettings.mockReset()
    mocks.preferences = { custom_cli_profiles: [], default_backend: 'codex' }
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('marks installed Devin as beta in the default backend list', async () => {
    mocks.installedBackends = ['claude', 'devin']
    const user = userEvent.setup()
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    await user.click(screen.getByRole('combobox', { name: 'Default Backend' }))

    const devin = screen.getByRole('option', { name: 'Devin' })
    const claude = screen.getByRole('option', { name: 'Claude' })
    expect(within(devin).getByText('Beta')).toHaveClass('bg-warning/10')
    expect(within(claude).queryByText('Beta')).toBeNull()
  })

  it('reloads the avatar when the persisted path changes', () => {
    const { rerender } = render(
      <GeneralPane projectId="project-1" projectPath="/projects/jean" />
    )
    const firstSrc = screen
      .getByRole('img', { name: 'Jean' })
      .getAttribute('src')

    mocks.projects = [project('avatars/project-1-new.png')]
    rerender(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    expect(screen.getByRole('img', { name: 'Jean' })).not.toHaveAttribute(
      'src',
      firstSrc
    )
  })

  it('saves the project name on blur only when it changed', () => {
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    const name = screen.getByLabelText('Name')

    fireEvent.change(name, { target: { value: ' Jean ' } })
    fireEvent.blur(name)
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(name, { target: { value: 'Jean App ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.blur(name)
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { projectId: 'project-1', name: 'Jean App' },
      expect.anything()
    )
  })

  it('saves the system prompt on blur only when it changed', () => {
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    const prompt = screen.getByLabelText('System Prompt')

    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.blur(prompt)
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(prompt, { target: { value: 'Use Rust' } })
    fireEvent.blur(prompt)
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { projectId: 'project-1', customSystemPrompt: 'Use Rust' },
      expect.anything()
    )
  })

  it('shows the inherited global backend until the project overrides it', () => {
    const { rerender } = render(
      <GeneralPane projectId="project-1" projectPath="/projects/jean" />
    )
    expect(screen.getByText('Inherits global: Codex')).toBeInTheDocument()

    mocks.projects = [
      { ...project('avatars/project-1-old.png'), default_backend: 'claude' },
    ]
    rerender(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    expect(screen.getByText('Overrides global')).toBeInTheDocument()
    expect(screen.queryByText('Inherits global: Codex')).toBeNull()
  })
})

describe('GeneralPane worktree pool', () => {
  beforeEach(() => {
    mocks.installedBackends = []
    mocks.updateSettings.mockReset()
    mocks.preferences = { custom_cli_profiles: [] }
  })

  it('turns the pool on with default min and max', () => {
    mocks.projects = [project('avatars/a.png')]
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    fireEvent.click(screen.getByLabelText('Keep ready worktrees'))

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePoolSettings: { enabled: true, min_idle: 1, max_idle: 2 },
      })
    )
  })

  it('keeps min at or below max and clamps to 1..10', () => {
    mocks.projects = [
      {
        ...project('avatars/a.png'),
        worktree_pool_settings: { enabled: true, min_idle: 2, max_idle: 3 },
      },
    ]
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    expect(screen.getByText('1 ready, 2 preparing')).toBeInTheDocument()

    const max = screen.getByLabelText('Max ready')
    fireEvent.change(max, { target: { value: '1' } })
    fireEvent.blur(max)
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktreePoolSettings: { enabled: true, min_idle: 1, max_idle: 1 },
      }),
      expect.anything()
    )

    const min = screen.getByLabelText('Min ready')
    fireEvent.change(min, { target: { value: '4' } })
    fireEvent.blur(min)
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktreePoolSettings: { enabled: true, min_idle: 4, max_idle: 4 },
      }),
      expect.anything()
    )

    fireEvent.change(min, { target: { value: '50' } })
    fireEvent.blur(min)
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktreePoolSettings: { enabled: true, min_idle: 10, max_idle: 10 },
      }),
      expect.anything()
    )
  })

  it('shows the saved value again when the input is left empty', () => {
    mocks.projects = [
      {
        ...project('avatars/a.png'),
        worktree_pool_settings: { enabled: true, min_idle: 2, max_idle: 3 },
      },
    ]
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    const min = screen.getByLabelText('Min ready')
    fireEvent.change(min, { target: { value: '' } })
    fireEvent.blur(min)

    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(min).toHaveValue(2)
  })
})
