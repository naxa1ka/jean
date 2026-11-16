# Plan queue: MCP tools, system prompt, findings review - design

Date: 2026-11-16. Status: approved by the user. Slices: `queue-mcp` 01-03.

## Intent

The native plan queue (`docs/developer/plan-queue.md`) runs `.jean/plans/*.md` slices unattended.
Today only the UI can use it. This work lets an agent in Jean use the queue and makes the queue act
on the findings that a slice reports.

Why: the user wants Claude to split large work into small slices and queue them without manual
steps, and does not want reported findings to stay unread in a session recap.

## Goals

1. Jean MCP has tools to read the queue, add a slice, change a slice or the queue, and turn the
   queue on for a project.
2. The default global system prompt tells each agent that the queue exists, when to use it and
   which tools to call.
3. After a slice that reported findings, a separate agent decides which findings are worth a fix.
   When some are, a new session applies a fix plan to the same slice (same branch, same PR).

## Non-goals

- A reorder tool for agents (agents add in run order; the UI can reorder).
- A findings view in the queue dialog. The sessions are in the worktree session list.
- Editable findings prompts (Magic Prompts). The prompts are constants.
- A new independent code review of the slice diff (`run_review_with_ai`). Possible later.
- Backends other than Claude for queue sessions (unchanged from v1).

## Anti-goals

- A loop. Findings are examined once per slice. A fix session never starts a new round.
- The same agent that wrote the slice decides about its own findings.
- The next slice starts before the fix of the previous slice is complete.
- An agent turns the queue on or adds slices without the user's agreement.

## Approaches (findings)

| # | Approach | Trade-off | Result |
|---|----------|-----------|--------|
| A | The slice session lists and fixes its own findings in a follow-up turn | Smallest change; the agent judges its own work | Rejected by the user |
| B | The runner calls `run_review_with_ai` on the slice diff | A full new review, not a decision about reported findings; the diff base is hard with stacked branches | Later, if necessary |
| C | Prompt only: the slice template tells the agent to fix findings | No runner change; no guarantee | Rejected |
| D | Separate agents: the slice agent writes findings to a file; a triage session decides and writes a fix plan; a fix session applies it | Independent decision; up to 2 small sessions more per slice with findings | **Chosen by the user** |

The user also decided: triage and fix are two sessions (a small session costs little), and there
is one round only.

## Design

### 1. MCP tools (slice 01)

All queue commands already have dispatch arms (`jean-core/src/http_server/dispatch.rs`,
`get_plan_queue`, `plan_queue_add`, `plan_queue_action`, `update_project_settings`). Each tool is
one schema entry plus a handler that calls `dispatch_command`. No new Tauri or dispatch command.

| Tool | Args | Result | Lists |
|------|------|--------|-------|
| `get_plan_queue` | `worktreeId` | `{ enabled, defaultModel, queue }` (`queue` = the `get_plan_queue` command result) | `READ_ONLY_SUBAGENT_TOOLS` |
| `plan_queue_add` | `worktreeId`, `name`, `content` | `{ name }` (the queued file name `NNN-<slug>.md`) | `RATE_LIMITED_TOOLS` |
| `plan_queue_action` | `worktreeId`, `action`, `name?` | `{ ok: true }` | `RATE_LIMITED_TOOLS` |
| `set_plan_queue_enabled` | `projectId`, `enabled`, `defaultModel?` | `{ projectId, enabled, defaultModel }` | `RATE_LIMITED_TOOLS`, `APPROVAL_TOOLS` |

- `action` is one of `pause`, `resume`, `retry`, `skip`, `unskip`, `remove`, `clear_blocked`.
- `set_plan_queue_enabled` loads the stored `plan_queue_settings` of the project, changes only the
  given fields and saves through `update_project_settings` with only `planQueueSettings`.
  `defaultModel`: absent = keep, empty string or null = clear.
- `set_plan_queue_enabled` is an approval tool: an autonomous Jean agent session needs the user's
  approval. In a normal chat the system prompt tells the agent to ask first.
- No new privilege: MCP can already start a full-access session (`create_session` +
  `send_chat_message`).
- Plan content can now come from an agent. The `needs-file` gate passes its git ref to
  `git show`, so the gate refuses a ref that starts with `-`.
- The approval card of `set_plan_queue_enabled` says on or off and names the project (frontend
  `describeApproval`, slice 02).
- Slice 03 adds `fixFindings` to `set_plan_queue_enabled` (optional argument) and to the
  `get_plan_queue` result.

### 2. System prompt (slice 02)

A new last section `## Jean Plan Queue` in the default global system prompt (Rust
`default_global_system_prompt()` and the TypeScript copy `DEFAULT_GLOBAL_SYSTEM_PROMPT`). It is not
conditional, as the other Jean sections. A stored prompt that is equal to the previous default must
count as a legacy default, so that those users get the new section. The section also tells the
agent that a slice must add a commit and that a dependent slice needs a `needs-slice` gate. The
default instructions have a size guard test (under 14,000 bytes); the section must fit it.

### 3. Findings review (slice 03)

Project setting `plan_queue_settings.fix_findings` (default false). When it is on:

```
plan run (session 1)  --Done--> .jean/findings/<plan file name> exists?
   no  -> done/
   yes -> triage run (session 2, changes no code) --> .jean/findings/<plan stem>.fix.md exists?
            no  -> done/
            yes -> fix run (session 3, message = fix plan text) -> done/ or failed/
```

- The plan file stays in `running/` for the full flow, so the next slice does not start.
- Files are the signals. The runner does not parse chat text.
- The plan message gets an appended instruction: write each finding to the findings file; no
  findings = no file.
- Triage session: reads the plan, `git diff <start_head>..HEAD` and the findings file. For each
  finding it decides: real? in the scope of the slice (caused by its changes, or necessary for its
  Goal / "Done when")? worth a fix now? It writes `fix` / `no fix` + reason under `## Triage` in
  the findings file. With at least one `fix` it writes a cold-start fix plan file.
- Fix session: its message is the fix plan text. It commits and pushes to the current branch.
- One round: the phase chain is `Plan -> Triage -> Fix -> end`. The findings instruction is
  appended only to the plan message. Maximum 3 sessions per slice.
- Outcome rules:
  - Plan phase: today's `decide_outcome`. Only a `Done` outcome can start triage.
  - Triage phase: session error, blocker marker or a session that never ran -> `failed/` with
    reason prefix `findings triage: `. Else fix plan file exists -> fix run. Else `done/`. A
    triage run makes no commit, so it does not go through `decide_outcome`.
  - Fix phase: `decide_outcome` with the HEAD at the start of the fix run. Not `Done` ->
    `failed/` with reason prefix `findings fix: `. A fix run never goes back to pending.
- A later phase always starts when its conditions are met, also when the queue is paused, the
  project switch was turned off or a foreign session is live. Pause and the switch stop the next
  plan, not the phases of the plan that runs.
- The run of a plan stays owned from the plan phase to the end of the last phase: the old run is
  replaced by the run of the next phase in one step, so the UI never shows the plan as stuck.
- After a `findings triage:` / `findings fix:` failure the work of the slice is already on its
  branch. To continue the stack, a human moves the plan file from `failed/` to `done/`. Retry
  runs the whole plan again (and can start one new round).
- Restart: `.sid.txt` in `running/` gets optional keys `phase`, `phaseSid` and `phaseHead` (HEAD
  at the start of the fix run). `sessionId` and `head` keep their meaning (plan session, plan
  start head), so older readers see no change. Recovery adopts or reclaims the session of the
  current phase. A reclaimed run (ended while Jean was closed) never starts a later phase. A
  `phaseSid` with an unknown phase counts as `Fix`.
- Queue sessions also get the parallel-execution prompt and the language from preferences (today
  the runner passes `None` for both).

## Calls made by the designer (not by the user)

- Findings and fix plan files live in `.jean/findings/` (next to `.jean/blocked/`, not in git).
- A triage or fix session error moves the plan to `failed/`, so the user sees it.
- The fix run must add a commit, as a slice must.
- The findings prompts are constants in `jean-core/src/plan_queue/`.
- The key name is `phaseSid`, not `phaseSessionId`: the old Node runner reads the session id with
  the pattern `sessionId=(\S+)`, and the new key must not be near that text.
- Later phases start also when the queue is paused or turned off.
- `plan_queue_add` and `plan_queue_action` have no approval gate; the tool descriptions and the
  system prompt tell the agent to ask the user.

## Left to the builder

- Exact prompt wording (the drafts in the slice plans give the content).
- Names of helper functions and the exact test list.
- Result shapes of the MCP tools where this document does not fix them.

## Notes

(Each slice adds one line here for a gap or a design conflict: `slice NN: <gap> -> <what you did>`.)
- slice 01: plan_queue_add / plan_queue_action have no approval gate (design table) -> the tool descriptions and the slice 02 prompt tell the agent to ask
- slice 01: needs-file accepts an absolute repo path, so a plan can test whether a file in another local git repo contains a text -> known exposure, kept; a ref that starts with - is refused before git runs
- slice 03: the design table lists neither `fixFindings` argument nor result field -> `set_plan_queue_enabled` takes optional `fixFindings` (absent = keep; other type = invalid params) and returns it; `get_plan_queue` returns `fixFindings`
- slice 03: after a `findings triage:` / `findings fix:` failure the work of the slice is already on its branch -> documented: move the plan file from `failed/` to `done/` by hand to continue the stack; Retry runs the whole plan again
