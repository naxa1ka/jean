# Native plan queue

## Purpose

The plan queue runs the plan files in `<worktree>/.jean/plans/` one by one.
Each plan runs in a new Claude session in YOLO mode. It replaces the external
Node runner `jean-queue`, which drove Jean through the Web Access WebSocket.
The native runner needs no WebSocket, PID file or stop script, and Web Access
can be off. The file format and folder layout are the same as jean-queue, so
the `plan-queue` skill and `jqp add` keep working.

Design: `docs/superpowers/specs/2026-11-15-native-plan-queue-design.md`.

## Turning it on

`Project.plan_queue_settings` (`enabled`, `default_model`) is saved through
`update_project_settings` (`planQueueSettings`). The switch and the model
picker are in Project Settings → General. `default_model: None` means Jean's
default Claude model.

## File layout

```
.jean/plans/*.md            pending; run order = file name sort
.jean/plans/running/        claimed plan + <plan>.sid.txt
.jean/plans/done/           + <plan>.sid.txt (the UI links the session)
.jean/plans/failed/         + <plan>.sid.txt (sessionId, at, reason)
.jean/plans/paused/         skipped plans, out of the queue
.jean/plans/QUEUE_PAUSED    marker: queue paused
.jean/blocked/*.md          blocker markers written by a plan session
```

- `<plan>.sid.txt` keeps the jean-queue format
  (`sessionId=…\nat=…\nworktree=…\nhead=…\n`), so a run claimed by one runner
  can be adopted by the other.
- The pause marker is `QUEUE_PAUSED`, not `PAUSED`: on a case-insensitive file
  system `PAUSED` and the `paused/` folder are the same name.
- Only `*.md` files in `.jean/blocked/` count (a `.gitkeep` does not block).
- Keep `.jean/` out of git: add it to the repo `.gitignore` or to
  `.git/info/exclude`. The runner moves files in `.jean/plans/` all the time,
  and plan sessions commit, so a `git add -A` in a plan can commit queue state.

## Code layout

| File                                              | Role                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `jean-core/src/plan_queue/outcome.rs`             | `decide_outcome` (pure port of jean-queue `outcome.mjs`)                 |
| `jean-core/src/plan_queue/gates.rs`               | `parse_needs` / `needs_met` (`needs-slice`, `needs-file`)                |
| `jean-core/src/plan_queue/files.rs`               | buckets, moves, atomic claim, `.sid.txt`, `NNN-` prefix, name validation |
| `jean-core/src/plan_queue/scheduler.rs`           | 10 s tick, claim/start/finish, restart recovery, wait reasons            |
| `jean-core/src/plan_queue/commands.rs`            | queue reads and mutations used by the dispatch arms                      |
| `src/services/plan-queue.ts`                      | query keys, `usePlanQueue`, `usePlanQueueSummaries`, mutations           |
| `src/components/plan-queue/PlanQueueDialog.tsx`   | queue dialog (mounted once in `MainWindow`)                              |
| `src/components/plan-queue/PlanQueueProgress.tsx` | canvas progress strip                                                    |
| `src/components/plan-queue/plan-queue-utils.ts`   | pure helpers (`planQueueStatusText`, `formatElapsed`, `movePlan`)        |

## Runner rules

`start_plan_queue_scheduler` starts from `initialize_runtime`. Every 10 s it
looks at each worktree of each project with `enabled = true`.

**Skip a worktree** when it has an owned live run, `QUEUE_PAUSED` exists, a
blocker marker exists, `running/` holds a plan that the runner does not own
(an orphan or another runner's claim), or a session that the runner did not
start is live in build or yolo mode.

**Pick** the lowest-sorted pending plan whose gate is met. Gates are in the
first 5 lines; a malformed gate line fails closed. When no plan is ready, the
runner stores a wait reason for the UI.

**Start:**

1. Create a Claude session (name = plan file name without `.md`).
2. Read HEAD (the start head).
3. Claim: one atomic rename into `running/`, then write `.sid.txt`. If the
   rename fails, another runner took the file: Jean closes its new empty
   session and skips the plan. This is the second-runner guard; there is no
   lockfile.
4. Model pin: `<!-- model: <id> -->` on the first line, else `default_model`.
   If the model cannot be set, the plan goes to `failed/` and is never sent. A
   plan never runs on a model other than its pin.
5. Send the plan text in YOLO mode in a task (the send awaits the whole turn).

**Outcome** (`decide_outcome`, in this order):

| Facts                                           | Bucket                                   |
| ----------------------------------------------- | ---------------------------------------- |
| session error (also `chat:cancelled`)           | failed: `session error`                  |
| blocker marker                                  | failed                                   |
| HEAD not readable                               | failed                                   |
| HEAD moved since the claim                      | done                                     |
| HEAD same, session never ran, earlier tries < 2 | pending again (re-queued)                |
| HEAD same, session never ran, 3rd try           | failed: `session never ran (3 tries)`    |
| HEAD same, otherwise                            | failed: `no new commit on worktree HEAD` |

The main end signal is the return of `send_chat_message`; chat end events and
the per-tick run-state check catch the rest. Tries are kept in memory and reset
on restart, as in jean-queue.

**Restart recovery:** the first time the runner sees a worktree of an enabled
project, each `running/*.md` is checked through its `.sid.txt` session id:
live → adopt, ended → decide the outcome and move, no sid or unknown state →
leave it as an orphan (the dialog shows it).

Queue commands and the tick share `scheduler::lock_queue`, so a command never
moves files while a tick picks, claims or finishes a plan.

## Commands and cache key

All commands go through one arm each in `jean-core/src/http_server/dispatch.rs`,
so native and web access share them. Args are camelCase.

| Command                    | Args                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `get_plan_queue`           | `worktreeId`                                                                                          |
| `get_plan_queue_summaries` | `projectId` (only worktrees that have a plans folder)                                                 |
| `plan_queue_add`           | `worktreeId, name, content` → `NNN-<slug>.md` at the end                                              |
| `plan_queue_reorder`       | `worktreeId, names` (must equal the pending set)                                                      |
| `plan_queue_action`        | `worktreeId, action, name?` — `pause`, `resume`, `retry`, `skip`, `unskip`, `remove`, `clear_blocked` |

- Mutating commands resolve the worktree path from Jean's project data (never
  from the client), validate `name` (plain `*.md` file name: no `/`, `\` or
  `:`, no `..`, no leading `.`), and refuse to touch a plan in `running/`.
- Every move or mutation emits `cache:invalidate` with the key `plan-queue`.
  All frontend query keys start with `plan-queue` (`planQueueQueryKeys`), so
  one invalidation refreshes the dialog and the canvas strips.
- `get_plan_queue_summaries` returns raw worktree ids from the owning server;
  `usePlanQueueSummaries` scopes them like the project id.

## UI entry points

- **Menu:** "Plan queue…" in `WorktreeDropdownMenu` and `WorktreeContextMenu`
  (through `useWorktreeMenuActions`), only when the project has the queue
  enabled. It sets `ui-store.planQueueTarget`, which opens `PlanQueueDialog`.
- **Canvas strip:** `ProjectCanvasView` calls `usePlanQueueSummaries` once
  (only when the queue is enabled) and passes each row its summary. The strip
  shows on every filter tab for a worktree with `total > 0`; on the Mr. Robot
  tab it comes after the Mr. Robot strip. The text comes from
  `planQueueStatusText` (blocked → stuck → paused → running → waiting →
  pending → done). "Stuck" means `orphaned`: a plan in `running/` that the
  runner does not own. Only owned plans count as `runningPlan`. A
  `failedCount > 0` adds `· N failed` (a drained queue shows
  `Queue 5/5 · 2 failed`, not `done`). Blocked, stuck, waiting and failed use
  the warning color. A click on the text opens the dialog; the button pauses or
  resumes, and it is hidden for a drained queue that is not paused.
- **Mobile:** compact rows show the strip as one muted line. Pause/Resume is in
  the row long-press menu (`PlanQueueMenuItem`, through the
  `WorktreeSectionHeader` `planQueue` prop).

## MCP tools

Jean MCP lets an agent read and change the queue. Each tool calls an existing
queue dispatch command (`run_tool` arm `get_plan_queue` / `plan_queue_add` /
`plan_queue_action` / `set_plan_queue_enabled`, handler `run_plan_queue_tool`
in `jean-core/src/jean_mcp_core.rs`). No new Tauri or dispatch command exists.

| Tool                     | Args                                    | Result                                 | Lists                                 |
| ------------------------ | --------------------------------------- | -------------------------------------- | ------------------------------------- |
| `get_plan_queue`         | `worktreeId`                            | `{ enabled, defaultModel, queue }`     | `READ_ONLY_SUBAGENT_TOOLS`            |
| `plan_queue_add`         | `worktreeId`, `name`, `content`         | `{ name }` (`NNN-<slug>.md`)           | `RATE_LIMITED_TOOLS`                  |
| `plan_queue_action`      | `worktreeId`, `action`, `name?`         | `{ ok: true }`                         | `RATE_LIMITED_TOOLS`                  |
| `set_plan_queue_enabled` | `projectId`, `enabled`, `defaultModel?` | `{ projectId, enabled, defaultModel }` | `RATE_LIMITED_TOOLS`, `APPROVAL_TOOLS` |

- `action` is one of `pause`, `resume`, `retry`, `skip`, `unskip`, `remove`,
  `clear_blocked`. Any other value is invalid params (-32602).
- `defaultModel`: absent keeps the stored model; an empty string or `null`
  clears it; a string is trimmed and stored.
- `set_plan_queue_enabled` loads the project's `plan_queue_settings`, changes
  only `enabled` and `defaultModel`, and saves the whole struct through
  `update_project_settings`. Folder projects are refused.
- **Approval rule:** only `set_plan_queue_enabled` is in `APPROVAL_TOOLS`. An
  agent session needs the user's approval for it. `plan_queue_add` and
  `plan_queue_action` have no gate: the tool descriptions and the system prompt
  tell the agent to ask the user first.
- **Gate ref rule:** a `needs-file` gate whose ref starts with `-` is not met
  (reason `bad gate ref: <ref>`), and git is not started. Plan content can now
  come from agents, and git would read a ref such as `--output=...` as an option.
- **Known exposure:** `needs-file` accepts an absolute `repo` path, so a plan
  can test whether a file in another local git repo contains a text.

## Migration from jean-queue

Jean cannot detect the Node runner. Before you turn on the switch:

1. Add the project to `excludeProjects` in the jean-queue `config.json` (or
   stop jean-queue).
2. Turn on Project Settings → General → Plan queue.

Plans already in `running/` from jean-queue are adopted through their
`.sid.txt`.
