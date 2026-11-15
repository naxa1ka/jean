/** Native plan queue (`.jean/plans/`) types. Mirror `jean-core/src/plan_queue/commands.rs`. */

export interface QueuePlan {
  name: string
  /** First `# ` heading, else the file name without `.md`. */
  title: string
  modelPin?: string
  /** Pending plans only: why the gate is not met yet. */
  gate?: string
}

export interface RunningPlan extends QueuePlan {
  sessionId: string
  startedAt?: string
}

export interface DonePlan extends QueuePlan {
  sessionId?: string
}

export interface FailedPlan extends QueuePlan {
  /** Empty when `.sid.txt` has no reason. */
  reason: string
  sessionId?: string
}

export interface PlanQueue {
  paused: boolean
  /** File names in `.jean/blocked/`. */
  blocked: string[]
  waitReason?: string
  pending: QueuePlan[]
  running: RunningPlan[]
  done: DonePlan[]
  failed: FailedPlan[]
  /** Plans in `paused/`, out of the queue. */
  skipped: QueuePlan[]
  /** Plans in `running/` that the runner does not own. */
  orphans: QueuePlan[]
}

export interface PlanQueueSummary {
  worktreeId: string
  pending: number
  doneCount: number
  failedCount: number
  /** pending + running + done + failed. */
  total: number
  /** First plan in `running/` that the runner owns. */
  runningPlan?: string
  runningSince?: string
  paused: boolean
  blocked: boolean
  /** A plan in `running/` that the runner does not own; the queue is stuck. */
  orphaned: boolean
  waitReason?: string
}

export type PlanQueueAction =
  | 'pause'
  | 'resume'
  | 'retry'
  | 'skip'
  | 'unskip'
  | 'remove'
  | 'clear_blocked'
