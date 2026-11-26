# Worktree groups inside a project — design


## Context / why

The user has many worktrees in one project. They want to put them in named groups by topic or work
type (for example "Bugs", "Features", "Experiments") and collapse the groups they do not need now.
They want to drag worktrees into groups, and drag groups to change their order.

Today: worktrees in one project are a flat list. In the left sidebar (`WorktreeList.tsx`) you can
drag them to change the order (`Worktree.order`, `reorder_worktrees`). On the project canvas
(`ProjectCanvasView.tsx`) the rows are grouped by run state ("Needs input / Running / Idle",
`canvas-row-state.ts`). Projects (not worktrees) already have folders (`Project.parent_id`,
`is_folder`, `create_folder`, `move_item`) — that is the pattern to follow.

## Goals

- Named, user-made groups of worktrees, per project. One level only (no groups inside groups).
- The same groups show in the left sidebar and on the project canvas, in native app, web access,
  and mobile.
- Collapse / expand a group with a click on its header. Collapse state is remembered per device.
- Drag a worktree into a group, out of a group, and between groups (desktop). Drag a group header to
  change the group order (desktop).
- Context menu "Move to group ▸" on a worktree (works on touch / mobile, where there is no drag).
- Create, rename, delete a group.

## Non-goals (v1)

- Nested groups, group colors/icons, per-group sort mode.
- "New worktree in this group" (new worktrees go to Ungrouped).
- Jean MCP tools for groups.
- Groups for the `auto_fix` (Mr Robot) worktrees on the Robot tab.

## Anti-goals (failure even if it works)

- A collapsed group hides a worktree that needs input, and the user does not see it. → A group
  header must show a waiting dot / running waveform when any of its worktrees waits / runs.
- Projects with no groups look or behave different from today.
- Group data is lost when a worktree is created, forked, archived, restored, or when the app restarts.

## Decisions

Decided by the user:
- Approach A: groups are stored with the project data (shared by all clients), not in the UI
  state and not made from labels.
- Show in both sidebar and canvas. On the canvas, user groups REPLACE the "Needs input / Running /
  Idle" headers. Inside each group, rows still sort waiting → running → idle (stable). Row state
  stays visible on each row (existing dot / waveform).

My calls (the user can correct):
- Base session always at the top, outside all groups. It cannot be put in a group.
- Worktrees with no group go under an "Ungrouped" header, after all groups. The header shows only
  when the project has at least one group.
- A project with zero groups renders exactly as today (canvas keeps state headers). No regression.
- Delete a group → its worktrees move to Ungrouped. Worktrees are never deleted by a group action.
  No confirm dialog needed (nothing is lost); show a toast.
- Duplicate group names in one project: rename to "Name (2)" like folders do. Name is trimmed, not
  empty, max 60 chars.
- New group: created with name "New group", then inline rename starts (folder pattern).
- Forked worktree (`fork_session_to_worktree`) keeps the source worktree's group. Other new
  worktrees start with no group.
- Group header shows: chevron, name, count of worktrees, waiting dot / running waveform summary.
- Search / filter tabs: empty groups are hidden while a search or a non-"all" tab is active. Groups
  with matches are shown expanded while searching (a search must not hide matches in a collapsed
  group).
- Pending (being created) worktrees show at the top, as today, outside groups.
- `auto_fix` (Mr Robot) worktrees cannot be grouped: backend rejects, UI hides "Move to group" and
  drop targets for them. The Robot tab always keeps the state headers.
- Remote servers: add a `worktreeGroups: 1` capability to `get_server_capabilities`
  (`jean-core/src/lib.rs` ~4659, read in `server-connections.ts`). Hide all group UI (menus,
  headers, drag targets) for a project whose server lacks it. Old servers would answer "Unknown
  command" and drop the new fields when they rewrite projects data.
- Menu "Move to group" puts the worktree at the end of the target group. Ungrouped can collapse.
  Opening a worktree in a collapsed group (search, keyboard, notification) expands that group.

## Data model

Rust (`jean-core/src/projects/types.rs`), snake_case (Pattern A, persisted data):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorktreeGroup { pub id: String, pub name: String, pub order: u32 }

// Project
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub worktree_groups: Vec<WorktreeGroup>,

// Worktree
#[serde(default, skip_serializing_if = "Option::is_none")]
pub group_id: Option<String>,
```

Neither struct derives `Default`: every struct literal must name the new field. Literals (from
exploration): `projects/commands.rs` Worktree at ~2104, 2836, 3109 (fork: copy `group_id` from
source), 3294, 3692, 3958, 4283, 4807; `Worktree::new_base` (types.rs ~937); Project at
commands.rs ~790, 955, 1018, 13233, tests ~15987/16173; `servers.rs` ~192, 720;
`auto_fix/scheduler.rs` ~1385, 1705, 1743. Compiler finds the rest.

A `group_id` that points to a missing group is treated as Ungrouped (UI) — no cleanup job needed.

TypeScript (`src/types/projects.ts`): `WorktreeGroup { id; name; order }`,
`Project.worktree_groups?: WorktreeGroup[]`, `Worktree.group_id?: string | null`.

## Commands (all in `jean-core/src/projects/commands.rs`)

All use `with_projects_data_mut` (atomic load-mutate-save under `PROJECTS_LOCK`). All validate that
the project exists, that each worktree belongs to `project_id`, that the group belongs to the
project, and that the base session is never grouped.

| Command | Args | Effect |
|---|---|---|
| `create_worktree_group` | project_id, name | adds group at the end, returns `WorktreeGroup` |
| `rename_worktree_group` | project_id, group_id, name | renames (dedupe) |
| `delete_worktree_group` | project_id, group_id | removes group, clears `group_id` on its worktrees |
| `reorder_worktree_groups` | project_id, group_ids | sets `order` 0..n by array position |
| `move_worktree_to_group` | project_id, worktree_id, group_id: Option, worktree_ids: Option<Vec> | sets `group_id`; if `worktree_ids` given, also sets `order` like `reorder_worktrees` (one atomic write) |

Register each as a match arm in `jean-core/src/http_server/dispatch.rs` (`dispatch_command`, serves
both Tauri and WebSocket — there is no `generate_handler!` entry to add), using `field(...)` dual
keys and `emit_cache_invalidation(app, &["projects"])`. Follow `reorder_worktrees`
(dispatch.rs ~570) for multi-server ID routing (`src/lib/server-command-routing.ts`).

## Frontend

- Hooks in `src/services/projects.ts`: `useCreateWorktreeGroup`, `useRenameWorktreeGroup`,
  `useDeleteWorktreeGroup`, `useReorderWorktreeGroups`, `useMoveWorktreeToGroup`. Optimistic
  update of `worktrees(projectId)` / project list caches, rollback on error (copy
  `useReorderWorktrees` ~3294). Moving with a new order honors `switchToManualSort` like today.
- Pure helper `src/lib/worktree-groups.ts`: `groupWorktrees(sortedWorktrees, groups)` →
  `{ base, pending, groups: [{ group, worktrees }], ungrouped }`; handles missing-group ids, keeps
  incoming order inside each bucket. Used by sidebar and canvas. Unit tested.
- Collapse state: `collapsedWorktreeGroupIds: Set<string>` in `src/store/projects-store.ts`,
  persisted per device as a new top-level key in `ClientViewState`
  (`src/lib/client-view-state.ts`, `client-view-state-store.ts`, scoped by server like
  `expanded_folder_ids`). Not in the shared Rust UI state.
- Group header component (shared look): `DisclosureChevron`, name, count, state summary; inline
  rename (copy `FolderTreeItem.tsx` pattern, `editingWorktreeGroupId` in store); context menu:
  Rename, Delete group, New group.
- Menus: project row (`ProjectContextMenu.tsx`) → "New worktree group". Worktree row
  (`WorktreeContextMenu.tsx`, sidebar) and canvas row menu (`WorktreeSectionHeader` in
  `ProjectCanvasView.tsx` ~1063) → "Move to group ▸" submenu: each group, "No group", "New group…".
  Canvas row menu today renders only on native / mobile; make sure "Move to group" is reachable on
  web desktop too (sidebar menu is enough there).
- Drag-and-drop (pragmatic-drag-and-drop, desktop only; touch keeps drag off):
  - Worktree row drop: before/after a row in any group → move to that group at that position.
  - Group header as drop target for worktrees: "into" → append at the end of the group. The
    Ungrouped header is a target too (clears group).
  - Group header draggable: reorder groups (edge before/after other group headers).
  - Keep the native HTML5 fallback handlers that both lists already have.
- Canvas (`ProjectCanvasView.tsx`), only when groups exist: render group headers instead of state
  headers (~3687-3826); inside each group apply `sortByCanvasRowState`; collapsed groups' rows are
  left out of `flatCards` and `cardRefs` so keyboard nav (`useCanvasKeyboardNav`) skips them;
  Cmd/Ctrl+Arrow keyboard move stays inside the group and row state. Drag rule: inside one group a
  row moves only among rows with the same row state (as today, so a drop never "jumps back");
  a drop on a row of another group or on a group header moves the worktree to that group.
- Mobile uses `ProjectCanvasView` (compact rows) and `MobileLeftSidebar`; group headers and the
  long-press "Move to group" menu must work there.

## Security

Local app, but commands are reachable over WebSocket (web access): check that worktree and group
ids belong to the given project (no cross-project edits). Group names are rendered as text only
(React escapes); no HTML.

## Slices (one PR each, plan queue)

1. **Backend + data layer**: Rust model, 5 commands, dispatch arms, Rust tests (serde
   default/back-compat, delete clears members, cross-project rejection, base session rejection,
   fork copies group), TS types, service hooks, `worktree-groups.ts` helper + tests. No UI.
2. **Sidebar groups (no drag)**: group headers, collapse + persistence, create / rename / delete,
   "Move to group ▸" menu. Tests for collapse persistence.
3. **Sidebar drag-and-drop**: worktree into/between groups, group reorder. e2e in
   `e2e/tests/worktree-drag-reorder.spec.ts` style.
4. **Canvas groups**: group headers replace state headers when groups exist, collapse, keyboard
   nav, selection, canvas row menu, mobile compact view; today's drag limited to one group.
5. **Canvas drag + docs**: drag between groups and onto headers, group reorder, developer doc.

Slice files: `C:\Users\user\.claude\plans\worktree-groups-INDEX.md` and `worktree-groups-0N-*.md`.

## Verification (whole feature)

- `cargo test --manifest-path jean-core/Cargo.toml worktree_group` (new Rust tests); narrow
  `bunx vitest run <paths>` and Playwright specs per slice (each slice file lists its commands).
- Native app (`bun run tauri dev`, via Jean run environment): create 2 groups, move worktrees by
  drag and by menu, collapse, restart app → groups, membership, collapse state kept.
- Web access + mobile width: groups show, "Move to group" works by long-press, no drag.
- Project with no groups: canvas and sidebar look as before.

## Left to the builder

Exact header styling, drop-indicator look, toast copy, test file names, hook internals.

## Notes
- Collapse keys: group UUID, or project id for Ungrouped; never scoped. (Slice 02 wins over the "scoped by server like `expanded_folder_ids`" line in Frontend.)
- Canvas (slice 04): while a search or a non-"all" tab is active, an empty Ungrouped header hides like empty groups (drag is off there, so it is no drop target). On "all" without search it always shows.
