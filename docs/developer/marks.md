# Marks

A **mark** is a named, colored tag on a session or a worktree (for example
"Review later"). The UI says "Mark". The code keeps the old names: `LabelData`,
`labels`, `LabelModal`.

## One mark list per server

- Each server stores its mark list in `AppPreferences.mark_definitions`
  (`MarkDefinition { name, color, icon, tracked }`). The list order is the display
  order. Names are unique, case-insensitive.
- Only `set_mark_definitions` (strict validation, replaces the list),
  `merge_mark_definitions` (adds new names, keeps known ones), `rename_mark`,
  and `remove_mark_everywhere` write the list.
  `save_preferences` / `patch_preferences` never change it.
- Client helpers: `setMarkDefinitions(serverId, list)` and
  `mergeMarkDefinitions(serverId, list)` in `src/services/marks.ts`. They use
  `invoke` for the local server and `invokeForServer` for a remote one, then put
  the returned list in the preferences query cache of that server.
- Settings → Marks (`src/components/preferences/panes/MarksPane.tsx`) edits the
  list of the Settings target server (`useSettingsTargetServerId`).
  `openPreferencesPane('marks', serverId)` opens it for a given server.

## Rename and remove everywhere (level 3)

Server commands in `jean-core/src/marks.rs`. They act on one server only.

- `count_mark_usage(name) -> { worktrees, sessions }`: read-only. It does not
  count archived worktrees or closed sessions.
- `rename_mark(oldName, newName)`: strict-validates the new name and fails when
  another entry already has it (case-insensitive). It renames the definition,
  then the mark on every worktree and session (`rename_in_labels`: keeps
  `color`, `pinned`, `added_at`; when the item already has the new name, the
  two become one).
- `remove_mark_everywhere(name)`: removes the definition, then the mark from
  every worktree and session.
- Rename and remove return the counts of the items that changed (closed sessions
  too) and emit `["preferences", "sessions", "projects"]`. Worktrees change in
  one `with_projects_data_mut` (projects lock held across load and save);
  sessions change through `with_existing_metadata_mut`, and only the sessions
  that have the mark are written.
- `update_worktree_labels` emits a `projects` invalidation.

**The client owns the project pins.** `pinned_labels` live in each client's
`projectCanvasSettings` and the client saves them to `ui-state.json` with
`save_client_ui_state`, which replaces the shared copy. So the server never
writes them. After a rename or remove, `renameMark` / `removeMarkEverywhere`
(`src/services/marks.ts`) change this client's pins for the projects of that
server (raw project id = local server, `serverId:projectId` = that server).
Other clients keep their own pins under the old name until the user pins again
there.

Settings → Marks at level 3: a name change calls `renameMark` ("Renamed in N
items"). "Remove from list" opens a confirm dialog with the usage counts and
"Also remove from these items" (checked: `removeMarkEverywhere`; unchecked: the
list only, the items keep an orphan mark).

## Rendering: `resolveMark`

Items keep a copy of `name` and `color`. At render time,
`resolveMark(label, definitions)` (`src/lib/marks.ts`) finds the definition with
the same name (case-insensitive). **The definition wins** for color and icon, so a
change in Settings shows everywhere at once, without a data rewrite.

- Read the list once per view with `useMarkDefinitions(serverId)` and pass it to
  the rows as a prop (`SessionMarkChips definitions`, `WorktreeSectionHeader
markDefinitions`). Do not call it in each list row.
- Use the item's own server: `getResourceServerId(worktreeId)` for sessions and
  sidebar rows, `project.serverId` on the canvas.

## Orphans

A mark on an item with no definition in the list is an **orphan**
(`resolveMark(...).orphan`). It keeps its own color and is never tracked. The
picker shows the item's orphans under "Not in list", with "Add to list"
(`mergeMarkDefinitions`). Removing a definition in Settings leaves the items as
they are, so their marks become orphans.

## Migration

- Server (slice 03): once (`marks_migrated`), the server adds every label in use
  on worktrees and sessions, plus the project `pinned_labels`, to the list.
- Client (`useMarksClientMerge`): once per server (localStorage
  `jean-marks-merged:<serverId>`), each client merges its local per-project label
  registry and pins into that server's list. The merge is a union by name, so a
  repeat is safe.
- The picker no longer writes the local registry
  (`projectCanvasSettings[projectId].labels`). The stored data stays for the
  old-server path.

## Capability levels (`marks` in `get_server_capabilities`)

| Level | Server supports          | Client behavior                                 |
| ----- | ------------------------ | ----------------------------------------------- |
| 0     | One label per session    | Session picker single-selects                   |
| 1     | Many marks per session   | Multi-select                                    |
| 2     | Managed mark list        | Picker and chips use the list; Settings → Marks |
| 3     | Rename/remove everywhere | Settings rename and remove change all items     |

Read the level with `useServerMarksLevel(serverId)` or
`getMarksLevelForResource(id)` (`src/lib/marks-level.ts`). The native app's local
core is always the client build level. Below level 2, `useMarkDefinitions`
returns `[]`, the picker lists the labels in use plus "Needs testing" (free-text
create, no recolor, no delete), and Settings → Marks shows "This server does not
support marks yet".
