# Worktree Groups

Users can put the worktrees of a project into named groups. The sidebar and
the project canvas show one collapsible header per group, plus an
"Ungrouped" header. Rows move between groups by drag or by the row menu
"Move to group".

## Data model

- `Project.worktree_groups: Vec<WorktreeGroup>` (`jean-core/src/projects/types.rs`,
  `src/types/projects.ts`). A group is `{ id, name, order }`.
  - `id` is a raw UUID v4. Group ids are **never** scoped with a server
    prefix: not in Rust, not in TS query caches, not in client view state.
  - `name` is trimmed, max 60 characters, unique per project.
  - `order` sorts the groups (ties by name, then id).
- `Worktree.group_id: Option<String>` points to a group of the same project.
  `None`, or an id that no longer exists, means "Ungrouped".
- Base sessions, auto-fix (Robot) worktrees and worktrees in flight
  (`pending`, `deleting`) are never grouped (`canGroupWorktree`,
  `effectiveGroupId` in `src/lib/worktree-groups.ts`).
- The row order inside a group is the normal persisted manual order
  (`Worktree.order`). Groups do not have their own row order.

Persisted data uses snake_case (Pattern A in `AGENTS.md`), with
`#[serde(default)]` for old project files.

## Commands

Five commands in `jean-core/src/projects/commands.rs`:

| Command                   | Effect                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `create_worktree_group`   | Adds a group at the end                                       |
| `rename_worktree_group`   | Renames a group                                               |
| `delete_worktree_group`   | Deletes a group; its worktrees become Ungrouped               |
| `reorder_worktree_groups` | Sets `order` from a full list of group ids                    |
| `move_worktree_to_group`  | Sets `group_id` (or `null`), optionally with a full row order |

`move_worktree_to_group` takes an optional `worktree_ids` (full ordered list),
so a drop at a position is one atomic save. The frontend hooks take
`switchToManualSort` and switch the project's canvas sort mode to manual.

There is no `generate_handler!` entry: `src-tauri/src/lib.rs` forwards to
`dispatch_core_command`. In `jean-core/src/http_server/dispatch.rs` the five
commands are matched by `WORKTREE_GROUP_COMMANDS` and handled in the boxed
`dispatch_worktree_group_command` function (keeps the stack frame of
`dispatch_command` small). Frontend hooks are in `src/services/projects.ts`
(`useCreateWorktreeGroup`, `useMoveWorktreeToGroup`,
`useReorderWorktreeGroups`, ...), all with `WORKTREE_GROUP_MUTATION_KEY`.

## Capability and UI gating

The server reports `capabilities.worktreeGroups` (level `1`) from
`get_server_capabilities` (`jean-core/src/lib.rs`).
`useWorktreeGroupsSupported(serverId)` (`src/lib/worktree-groups-level.ts`)
reads it for the transport or the remote server that owns the project. When
the level is `0` (older server), the UI treats the project as having no
groups: no headers, no "Move to group" menu, plain drag reorder.

## Collapse state

Collapse is per device, in client view state
(`collapsed_worktree_group_keys` in `src/lib/client-view-state.ts`, store
field `collapsedWorktreeGroupKeys`). The key is the group UUID, or the
project id for the Ungrouped header (`worktreeGroupCollapseKey`). Keys are
never scoped. The sidebar and the canvas share the same keys.

## Grouping and drop rules

- `groupWorktrees(sortedWorktrees, groups)` splits an already sorted list into
  `pending`, `base`, one bucket per group (sorted by `order`, empty groups
  too) and `ungrouped`. Every bucket keeps the incoming order.
- `resolveWorktreeGroupDrop` (`src/lib/drag-and-drop/worktree-group-drop.ts`)
  is the one pure drop resolver for the sidebar and the canvas. It returns
  `reorder`, `move` (with the target group) or `reorderGroups`, or `null`
  when the drop is not allowed:
  - row on row, same group -> `reorder`; other group -> `move` at that
    position;
  - row on a group header (or Ungrouped) -> `move` to the end of that group;
    on its own header -> `reorder` to the end of its group;
  - group header on group header -> `reorderGroups` (Ungrouped is never
    dragged and never a group-drag target);
  - optional `rowStateById` (canvas only): a same-group row-on-row drop needs
    both rows in the same row state. Moves to another group allow any state.
- `fullOrderedIds` is always the **persisted** order (base session and rows
  of collapsed groups included), never the grouped or state-sorted display
  order. Grouping must not leak into the manual order.
- Drag data and drop-target data carry `scope` (`DRAG_SCOPE_WORKTREE_LIST` or
  `DRAG_SCOPE_CANVAS_WORKTREE_LIST`) and `projectId`. Every monitor checks
  both, so one drag never commits twice.
- Header DOM contract: every header has `data-worktree-group-id` (UUID or
  `ungrouped`), `data-worktree-group-project-id` and
  `data-worktree-group-scope`. Native HTML5 fallbacks look up headers only
  inside their own list container and by scope + project
  (`getWorktreeListElement`), never by a bare `[data-worktree-group-id]`.
- Hovering a collapsed header for 500 ms while dragging a row expands it.

## Sidebar vs canvas

- **Sidebar** (`src/components/projects/WorktreeList.tsx`,
  `WorktreeGroupHeader.tsx`): rows keep the sort-mode order inside a group.
  The header has rename (double-click), delete and "New group".
- **Canvas** (`src/components/dashboard/ProjectCanvasView.tsx`,
  `CanvasWorktreeGroupHeader.tsx`, `canvas-worktree-groups.ts`): in grouped
  mode the group headers replace the row-state headers (Needs input /
  Running / Idle). Inside a group, rows are sorted by row state, so a dropped
  row can show at the end of its state band. The header only toggles
  collapse; rename and delete live in the sidebar.
- The canvas Robot (`auto_fix`) tab is never grouped. While a search or a
  non-`all` tab is active, empty groups hide and drag is off
  (`canvasReorderEnabled`).
- Drag is off on mobile width (canvas) and on touch devices (sidebar); they
  use the row context menu (long-press) "Move to group".

Design notes: `docs/superpowers/specs/2026-11-26-worktree-groups-design.md`.
