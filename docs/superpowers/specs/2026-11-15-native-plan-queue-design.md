# Native plan queue — design

Date: 2026-11-15
Status: implemented (slices 01-05)

## Intent

The external tool `jean-queue` (`P:\Tools\jean-queue`, Node, about 860 lines) runs
plan files one after another. Each plan runs in a new Jean Claude session in YOLO mode.
It controls Jean from the outside through the Web Access WebSocket. About half of its
code works around problems that come from this:

- dead sockets
- `send_chat_message` acks that come only when the run ends (4 of the last 7 plans
  logged `START?`)
- "never ran" requeues
- key-name guessing
- the PID file and the stop scripts

It also needs Web Access on. On this machine, Web Access has no token and binds to a
tailnet IP.

This design moves the runner into Jean as a Rust scheduler and adds a small UI. The
plan file format and the folder layout do not change, so the `plan-queue` skill and
`jqp add` keep working.

## Goals

1. Jean runs `.jean/plans/*.md` queues natively, with the same rules as `jean-queue`:
   - order
   - done, failed and requeue outcomes
   - gates
   - model pin
   - waiting for sessions that the runner did not start
2. No WebSocket, PID file or stop script. Web Access can be off.
3. A worktree queue panel shows the plans by state and lets the user:
   - add a plan
   - reorder plans
   - retry, skip or remove a plan
   - pause or resume the queue
   - clear a blocker
4. A progress line under a worktree row on the project canvas shows queue status.
5. All of this works in the native app, in web access and on mobile (repo rule).

## Non-goals (v1)

- Automatic PR creation, or waiting for a PR to merge. The plan text still tells the
  session to branch, commit and open the PR, as it does today.
- Backends other than Claude.
- A file watcher. A 10 s poll is enough, as in the Node runner and Mr. Robot.
- Editing plan text inside Jean.
- A canvas "Queue" filter tab, sidebar badges, a project-wide queue view.
- Any change to Mr. Robot.

## Anti-goals (failure even if it "works")

- A plan runs twice, or two runners take the same folder at the same time.
- A plan runs on a model other than its pin. If the pin cannot be set, the plan fails
  and is not sent.
- A plan is marked done without a new commit on HEAD.
- A UI action reads or writes a path outside `<worktree>/.jean/`.

## Constraints

- Rust core lives in `jean-core/src`. `src-tauri` is a thin shell. Every command goes
  through the `dispatch.rs` match (`src-tauri/src/lib.rs:427` registers
  `dispatch_core_command` for all core commands, plus a few desktop-only commands),
  so one dispatch arm serves native and web access.
- Events to the frontend use `app.emit_all` (`http_server/mod.rs:348`), so web clients
  get them too.
- Persisted settings use snake_case with `#[serde(default)]`.
- Use `silent_command()` for git calls (Windows console flash).
- Tests: inline `#[cfg(test)] mod tests`, `tempfile::tempdir()`.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Native Rust runner in `jean-core/src/plan_queue/` + UI | Most work. Removes every WebSocket workaround. Web Access can be off. Same files. |
| B | UI in Jean only, Node runner stays | Fastest. Ack timeouts stay. Web Access must stay on. UI sees only the folders. |
| C | Add "plan files" as a source to Mr. Robot | Reuses the most code. But Mr. Robot runs GitHub issues in parallel, and the queue is strictly ordered with gates. The two ideas fight. |

The user picked A.

## Design

### File layout (unchanged from jean-queue)

```
<worktree>/.jean/plans/              pending, run order = filename sort
<worktree>/.jean/plans/running/      claimed plan + <plan>.sid.txt
<worktree>/.jean/plans/done/          + <plan>.sid.txt (NEW: kept so the UI can link the session)
<worktree>/.jean/plans/failed/       + <plan>.sid.txt (sessionId, at, reason)
<worktree>/.jean/plans/paused/       skipped plans, out of the queue
<worktree>/.jean/plans/QUEUE_PAUSED  NEW: marker file, queue paused (no .md, so jean-queue ignores it)
<worktree>/.jean/blocked/*.md        blocker markers written by a plan session (only .md counts, as in jean-queue)
```

`<plan>.sid.txt` keeps the jean-queue format
(`sessionId=…\nat=…\nworktree=…\nhead=…\n`). So a run that the Node runner claimed can
be adopted after a switch, and the other way around.

### Turning it on

- New project field `plan_queue_settings: Option<ProjectPlanQueueSettings>` next to
  `auto_fix_settings` (field at `projects/types.rs:301`, struct at `:96`), with these fields:
  - `enabled: bool`, default `false`
  - `default_model: Option<String>`, the model for plans with no pin. `None` = Jean's
    default Claude model.
- Saved through `update_project_settings` with a new `plan_queue_settings:
  Option<Option<…>>` param, like `auto_fix_settings`.
- UI: a switch and a model picker in the Project Settings → General pane. *(My call: no
  new pane for two fields.)*
- Migration: the user adds the project to `excludeProjects` in jean-queue
  `config.json` (or stops the Node runner) before turning this on. The setting help text
  says this. Jean cannot detect the Node runner.
- Guard against a second runner *(my call)*:
  - Jean's claim is one atomic rename into `running/`. If the rename fails (another
    runner took the file), Jean deletes its new session and skips the plan.
  - A worktree whose `running/` holds a plan with a live session that Jean does not
    own is skipped, through the same rule as sessions that the runner did not start.
  - No lockfile. A lockfile works only if jean-queue respects it too, and jean-queue
    will be retired.

### Runner (`jean-core/src/plan_queue/`)

- `outcome.rs`: a port of `outcome.mjs` `decideOutcome` (pure). `MAX_UNSTARTED_TRIES = 3`.
- `gates.rs`: a port of `parseNeeds` and `needsMet`. Only the first 5 lines count.
  - `needs-slice`: the slug (`NNN-` prefix optional) is in `done/`.
  - `needs-file`: `git show <ref>:<file>` in `<repo>` contains `<text>`.
  - A malformed line fails closed.
- `files.rs`:
  - list the buckets
  - move a file (rename, else copy + delete)
  - read and write `.sid.txt`
  - the next `NNN` prefix
  - name validation: a plan name must be a plain file name that ends in `.md`, with no
    separators and no `..`
- `scheduler.rs`: started from `initialize_runtime` next to `start_auto_fix_scheduler`
  (`lib.rs:5596`).
  - **Tick every 10 s.** For each worktree of each project with `enabled = true`, skip
    the worktree when any of these is true:
    - it has an owned live run
    - the `QUEUE_PAUSED` marker exists
    - a `*.md` file exists in `.jean/blocked/`
    - a session that the runner does not own is live in build or yolo mode (the rule
      from `worktreeHasForeignLiveSession`)
  - **Pick a plan.** Take the lowest-sorted pending plan whose gate is met. If none is
    ready, store a WAIT reason for the UI.
  - **Start a plan:**
    1. `chat::create_session` (backend claude).
    2. Read HEAD (the start head).
    3. Claim: move the file to `running/` and write `.sid.txt`.
    4. Resolve the model (the pin on the first line, `<!-- model: <id> -->`, else
       `default_model`). Call `set_session_model`. If it fails, move the plan to
       `failed/` with the reason and send nothing.
       - `set_session_model` does not check the id (`chat/commands.rs:6219`). A
         mistyped pin makes the CLI fail, so the run ends as a session error and the
         plan goes to `failed/`. It never runs on another model. *(My call: no
         check against a model list.)*
       - Other settings (provider, thinking, effort) are the normal new-session
         defaults, as in jean-queue. *(My call: no per-project fields for them.)*
    5. Spawn `chat::send_chat_message(.., Some(model), Some("yolo"), ..)` in a task.
       That call awaits the whole turn.
  - **Finish:**
    - For an owned session, listen for `chat:done`, `chat:error` and `chat:cancelled`
      (`RuntimeContext::listen`, as `scheduler.rs:551` does).
    - On each tick, also check owned sessions through
      `load_metadata(..).run_state(is_session_actively_managed(..))`, for missed events.
    - When the run ends, call `decideOutcome` with:
      - the status
      - the blocker marker
      - HEAD now and the start head
      - `seen_running`
      - the tries
    - Move the plan to the bucket that `decideOutcome` returns, and write
      `.sid.txt` for a done or failed plan.
    - `seen_running` is false when the run ended but the session never went live
      and recorded no runs. A failed send is already a session error, which
      `decideOutcome` checks first.
  - **In-flight guard:** a static `Mutex<HashMap<session_id, OwnedRun>>` plus a set of
    worktree ids, in the style of `YOLO_IN_FLIGHT` (`auto_fix/scheduler.rs:88`, a `HashSet`).
  - **Restart recovery:** on startup, for each `running/*.md`, read the session id from
    `.sid.txt` and check its run state:
    - live → adopt it
    - ended → decide the outcome and move the plan
    - no sid or unknown state → leave it in `running/` and show it as "orphan" in the UI
  - **Tries:** in memory, reset on restart (same as jean-queue).
  - **Events:** after each move or state change, call
    `emit_all("cache:invalidate", {"keys": ["plan-queue"]})`.
  - **Log:** use `log::info!` with jean-queue-style verbs (CLAIM, START, DONE, FAILED,
    REQUEUE, WAIT, SKIP). No separate log file.

### Commands (one dispatch arm each, in `dispatch.rs`)

| Command | Args | Result |
|---|---|---|
| `get_plan_queue` | `worktreeId` | `{ paused, blocked: [file], waitReason?, pending: [Plan], running: [Plan & {sessionId, startedAt}], done: [Plan & {sessionId?}], failed: [Plan & {reason, sessionId?}], skipped: [Plan], orphans: [Plan] }`, where `Plan = {name, title, modelPin?, gate?}` |
| `get_plan_queue_summaries` | `projectId` | `[{worktreeId, pending, doneCount, total, runningPlan?, runningSince?, paused, blocked, waitReason?}]`, only worktrees that have a plans folder |
| `plan_queue_add` | `worktreeId, name, content` | writes `NNN-<slug>.md` at the end of the queue |
| `plan_queue_reorder` | `worktreeId, names: [string]` | renames pending plans to `001…` in the given order. Rejects the call if the set differs from the current pending set. |
| `plan_queue_action` | `worktreeId, action, name?` | `pause`, `resume`, `retry` (failed → pending, at the end), `skip` (pending → paused/), `unskip` (paused/ → pending, at the end), `remove` (deletes the pending file), `clear_blocked` (deletes the `*.md` files in `.jean/blocked/`) |

- Commands are camelCase (Pattern B).
- Every mutating command:
  - resolves the worktree path from `worktreeId` through Jean's own project data, never
    from client input
  - validates `name`
  - refuses to touch a plan in `running/`
- Every mutating command emits the `plan-queue` invalidation.
- Add a `plan-queue` case to `applyCacheInvalidationKeys`
  (`src/hooks/useMainWindowEventListeners.ts:237`).

### Frontend

- `src/services/plan-queue.ts`: a query key factory and hooks
  `usePlanQueue(worktreeId)` and `usePlanQueueSummaries(projectId)`, following
  `checkpoints.ts` and the `invokeForServer` pattern (`projects.ts:2977`), plus
  mutation wrappers.
- **Queue panel:** `src/components/plan-queue/PlanQueueDialog.tsx`, a shadcn Dialog.
  On mobile width it is full screen.

  ```
  Plan queue — trial129-pack                [Running ▸ Pause]
  ─────────────────────────────────────────────────────────
  ! Blocked: .jean/blocked/BLOCKED-03.md     [Clear & resume]
  ✓ 001-pr-draft-merged    done              [Session]
  ~ 003-ui-check           running · 4m      [Session]
  · 004-triage-asks        waits: slice 003  ⋮
  · 005-polish             claude-opus-5-5   ⋮
  ✗ 002-friction           no new commit     [Retry] ⋮
  ─────────────────────────────────────────────────────────
  [+ Add plan]   or drop .md files here
  ```

  - Sections in this order: Blocked banner, Running, Pending (draggable), Failed,
    Skipped, Done (collapsed).
  - ⋮ menu: Skip, Remove (confirm dialog), Unskip.
  - `[Session]` opens the session through the existing session-open path.
  - **Add plan:** a small form (name + paste text), plus drag-drop of `.md` files. The
    browser reads the file text, so it works in web access too.
  - Clear blocked asks for confirmation and shows the blocker file names. *(My call: v1
    shows only names, not file content.)*
- **Entry point:** a "Plan queue…" item in `WorktreeDropdownMenu.tsx` and
  `WorktreeContextMenu.tsx` (through `useWorktreeMenuActions`). It shows only when the
  project has the queue enabled.
- **Progress line:** a `PlanQueueProgress` strip under a worktree row in
  `ProjectCanvasView.tsx`, in the same position and style as `MrRobotProgress`
  (`MrRobotPanel.tsx:30`, used at `ProjectCanvasView.tsx:3965`).
  - It shows only when the summary for that worktree exists and `total > 0`.
  - It shows on every canvas filter tab, not only one tab. *(My call.)* On the
    Mr. Robot tab a row can show both strips: the Mr. Robot strip first, then the queue strip.
  - Text: `Queue 3/5 · running 003-ui-check · 4m`, or `Queue paused`,
    `Queue blocked`, or `Queue waiting: <reason>`.
  - One button: Pause or Resume. A click on the text opens the dialog.
  - On mobile compact rows, it uses one muted line, and the button moves into the
    long-press menu.
  - Data: one `usePlanQueueSummaries(projectId)` query per canvas.

## Left to the builder

- Exact Rust struct names, and whether the in-memory state lives in one struct or in
  statics.
- Whether drag reorder uses an existing dnd helper in the repo (canvas rows already
  drag) or simple up/down buttons, if dnd is heavy in a dialog.
- Dialog layout details within shadcn conventions.
- How to split this into PR-sized slices. Suggested order:
  1. core (`outcome`, `gates`, `files` + tests)
  2. settings + scheduler + recovery
  3. commands + dispatch + invalidation
  4. dialog + menu item
  5. progress line + mobile + docs

## Verification

- Rust unit tests:
  - every `decideOutcome` branch (port `outcome.test.mjs`)
  - gate parsing, including the fail-closed cases
  - `needs-slice` with and without the prefix
  - name validation (reject `..`, `/`, `\`, names without `.md`)
  - reorder renaming
  - adopting a `.sid.txt` written by jean-queue
  - a `.gitkeep` in `.jean/blocked/` does not block the queue
  - a failed claim rename deletes the new session and skips the plan
- Manual check in the native app:
  1. Turn the queue on for one project.
  2. Add 2 small plans (one with a model pin).
  3. Check that they run in order and land in `done/`.
  4. Add a plan that writes `.jean/blocked/x.md`. Check that the queue stops and the
     banner shows. Clear it and check that the queue resumes.
- Web access: open the dialog, then add, reorder and remove a plan.
- Mobile width: check the dialog and the progress line.
- Docs: a section in `docs/developer/` (runner, file layout, commands) and a user guide
  page.

## Notes

- slice 01: sibling modules in `jean-core/src/lib.rs` are private `mod`, but nothing uses the core yet → declared `pub mod plan_queue` so `clippy -D warnings` has no dead-code errors before slice 02.
- slice 01: jean-queue `nextPrefix` gives `000` when the pending names have no numeric prefix (max of `-1`) → ported as is, to keep the same file names as the Node runner.
- slice 02: extra skip rule: a worktree whose `running/` holds a plan that the runner does not own (an orphan, or another runner's claim) is skipped. Without it the next plan could start while an earlier one is still unresolved.
- slice 02: recovery runs the first time the runner sees a worktree of an enabled project (one time for each process), not only at app start. So when a user turns the queue on later, the `running/` plans are also recovered.
- slice 02: end signal: the return of `send_chat_message` is the main signal, because it awaits the whole turn. A chat end event ends a run while the send is still in flight. `chat:cancelled` and an error run state count as a session error. A live run state never ends a run.
- slice 02: "delete the new session" after a failed claim uses `chat::close_session`, which removes a session with no messages.
- slice 02: the session name is the plan file name without `.md`. Thinking and effort are `None`, so the normal new-session defaults apply.
- slice 03: the pause marker is `QUEUE_PAUSED`, not `PAUSED`. On a case-insensitive file system (Windows, default macOS) `PAUSED` and the `paused/` folder are the same name: a skipped plan made the queue look paused, and Pause failed when `paused/` existed. The check is `is_file()`.
- slice 03: queue commands hold the runner lock (`scheduler::lock_queue`), so a command never moves files while a tick picks, claims or finishes a plan.
- slice 03: `gate` in a pending `Plan` is the reason its gate is not met (absent when met). `startedAt` (running) is absent when `.sid.txt` has no `at`; `reason` (failed) is empty when `.sid.txt` has none.
- slice 03: retry and unskip give the plan the next `NNN-` prefix and keep the rest of the name. `plan_queue_add` strips a `.md` suffix and an `NNN-` prefix from the name before slugify, and rejects empty text.
- slice 03: `get_plan_queue_summaries` returns raw worktree ids from the owning server; `usePlanQueueSummaries` scopes them like the project id, so they match canvas worktree ids for remote servers.
- slice 04: the menu icon is reicon `OrderedList` (exported as `ListOrdered`), not lucide: a test forbids `lucide-react` imports in `src/`.
- slice 04: reorder uses up/down buttons, not drag. The repo has no dnd library (canvas rows use native HTML5 drag), HTML5 drag does not work with touch at mobile width, and it would clash with the `.md` file drop zone in the same dialog.
- slice 04: the blocker button is "Clear blocker", not "Clear & resume": `clear_blocked` only deletes the markers. A paused queue stays paused.
- slice 04: the add area also has a "Choose .md files" button (file input, read with `File.text()`), because mobile has no file drag-drop.
- slice 04: the default-model picker lists the Claude `modelOptions` plus "Use Jean default" (`null`). A saved id that is not in the list is still shown.
- slice 05: the canvas queries summaries and shows the strip only when the project has the queue turned on (same rule as the menu entry). With the switch off, Pause/Resume would have no runner to act on.
- slice 05: status text priority is blocked → paused → running → waiting → pending → done. Blocked and paused win over a running plan, because they ask the user to act. The `3/5` position is `total - pending`, so failed plans count as handled.
- slice 05: the design's Docs line also asks for a user guide page. The slice asks only for `docs/developer/plan-queue.md`, so no user guide page was added.
