import React, { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import {
  useArchivedWorktrees,
  useDeleteWorktree,
  useProjects,
  useUnarchiveWorktree,
} from '@/services/projects'
import { InlineField } from '../InlineField'

/**
 * Archived worktrees with Restore / Delete now. Archived worktrees keep their
 * folder and branch until the auto-delete period passes.
 */
export const ArchivedWorktreesField: React.FC = () => {
  const { data: archived = [] } = useArchivedWorktrees()
  const { data: projects = [] } = useProjects()
  const unarchive = useUnarchiveWorktree()
  const deleteWorktree = useDeleteWorktree()

  const rows = useMemo(() => {
    const projectNames = new Map(projects.map(p => [p.id, p.name]))
    return [...archived]
      .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0))
      .map(worktree => ({
        worktree,
        projectName: projectNames.get(worktree.project_id) ?? 'Unknown project',
        archivedOn: worktree.archived_at
          ? new Date(worktree.archived_at * 1000).toLocaleDateString()
          : '',
      }))
  }, [archived, projects])

  return (
    <InlineField
      label="Archived worktrees"
      description="Restore a worktree, or delete its folder and local branch now"
    >
      {rows.length === 0 ? (
        <span className="text-sm text-muted-foreground">
          No archived worktrees
        </span>
      ) : (
        <ul className="w-full space-y-2 sm:w-80">
          {rows.map(({ worktree, projectName, archivedOn }) => (
            <li
              key={worktree.id}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">{worktree.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {projectName}
                  {archivedOn && ` · archived ${archivedOn}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unarchive.isPending}
                  onClick={() => unarchive.mutate(worktree.id)}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteWorktree.isPending}
                  onClick={() =>
                    deleteWorktree.mutate({
                      worktreeId: worktree.id,
                      projectId: worktree.project_id,
                    })
                  }
                >
                  Delete now
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </InlineField>
  )
}
