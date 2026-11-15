//! Background runner for `.jean/plans/` queues. Port of the jean-queue run loop.
//!
//! Every [`TICK_SECONDS`], for each worktree of each project with
//! `plan_queue_settings.enabled`, the runner starts the next ready plan in a new
//! Claude session in yolo mode, then moves the plan to `done/`, `failed/` or back
//! to pending when the run ends. Plans in `running/` that the runner does not own
//! (left by a restart or by jean-queue) are adopted, reclaimed or left as orphans
//! the first time the runner sees the worktree.
//!
//! The decisions are pure functions at the top of this file; the IO below only
//! gathers facts and applies the decisions.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use tauri::AppHandle;

use super::files::{claim_atomic, has_blocker_marker, list_bucket, move_into, SidFile};
use super::gates::{needs_met, parse_needs, GateResult};
use super::outcome::{decide_outcome, Bucket, RunEnd, RunFacts};
use crate::chat::types::RunStateStatus;
use crate::http_server::EmitExt;
use crate::platform::{output_with_timeout, silent_command};
use crate::projects::types::{ProjectPlanQueueSettings, Worktree};

const TICK_SECONDS: u64 = 10;
const GIT_HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Marker file in `.jean/plans/`: the queue of this worktree is paused.
pub const PAUSED_MARKER: &str = "PAUSED";

static MODEL_PIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!-- model: (\S+) -->").unwrap());

// ---------------------------------------------------------------- pure rules

/// Facts about one worktree that decide whether the runner may start a plan.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorktreeFacts {
    /// A run that this runner owns is live in the worktree.
    pub owned_live: bool,
    /// `.jean/plans/PAUSED` exists.
    pub paused: bool,
    /// `.jean/blocked/` has a `*.md` file.
    pub blocked: bool,
    /// `running/` has a plan that this runner does not own (orphan or other runner).
    pub unowned_running: bool,
    /// A session that this runner does not own is live in build or yolo mode.
    pub foreign_live: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    OwnedRun,
    Paused,
    Blocked,
    UnownedRunning,
    ForeignSession,
}

impl Skip {
    fn reason(self) -> &'static str {
        match self {
            Skip::OwnedRun => "a queue run is live",
            Skip::Paused => "queue paused (PAUSED marker)",
            Skip::Blocked => {
                "blocker marker in .jean/blocked/; queue stopped until a human clears it"
            }
            Skip::UnownedRunning => "running/ holds a plan this runner does not own",
            Skip::ForeignSession => "foreign build/yolo session running; deferring queue",
        }
    }
}

pub fn skip_reason(f: &WorktreeFacts) -> Option<Skip> {
    if f.owned_live {
        Some(Skip::OwnedRun)
    } else if f.paused {
        Some(Skip::Paused)
    } else if f.blocked {
        Some(Skip::Blocked)
    } else if f.unowned_running {
        Some(Skip::UnownedRunning)
    } else if f.foreign_live {
        Some(Skip::ForeignSession)
    } else {
        None
    }
}

/// One session as the foreign-session rule sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionView {
    pub id: String,
    pub live: bool,
    /// Live run's execution mode, else the selected mode.
    pub mode: Option<String>,
}

/// Port of jean-queue `worktreeHasForeignLiveSession`: only a live session in
/// build or yolo mode that the runner does not own blocks the queue.
pub fn has_foreign_live_session(sessions: &[SessionView], owned: &HashSet<String>) -> bool {
    sessions.iter().any(|s| {
        s.live
            && !owned.contains(&s.id)
            && s.mode
                .as_deref()
                .is_some_and(|m| m.eq_ignore_ascii_case("build") || m.eq_ignore_ascii_case("yolo"))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    Ready {
        name: String,
        text: String,
    },
    /// Pending plans exist but none has its gate met.
    Wait(String),
    Empty,
}

/// The lowest-sorted pending plan whose gate is met. `pending` is in run order.
pub fn pick_plan(pending: Vec<(String, String)>, mut gate: impl FnMut(&str) -> GateResult) -> Pick {
    let count = pending.len();
    let mut first_reason = None;
    for (name, text) in pending {
        let result = gate(&text);
        if result.met {
            return Pick::Ready { name, text };
        }
        first_reason.get_or_insert_with(|| format!("{name}: {}", result.reason));
    }
    match first_reason {
        Some(reason) => Pick::Wait(format!("{count} pending, none ready ({reason})")),
        None => Pick::Empty,
    }
}

/// The pin on line 1 (`<!-- model: <id> -->`), else the project default, else none.
pub fn resolve_model(text: &str, default_model: Option<&str>) -> Option<String> {
    let first = text.lines().next().unwrap_or("");
    if let Some(caps) = MODEL_PIN.captures(first) {
        return Some(caps[1].to_string());
    }
    default_model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
}

/// How a run that ended maps to the outcome status. `None` while it is live.
pub fn run_end_for(status: RunStateStatus) -> Option<RunEnd> {
    match status {
        RunStateStatus::Running | RunStateStatus::Resumable => None,
        RunStateStatus::Idle => Some(RunEnd::Done),
        RunStateStatus::Error | RunStateStatus::Cancelled => Some(RunEnd::Error),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    Adopt,
    Reclaim(RunEnd),
    Orphan,
}

/// What startup recovery does with a `running/*.md` plan.
pub fn recovery_action(session_id: Option<&str>, status: Option<RunStateStatus>) -> Recovery {
    if session_id.is_none_or(str::is_empty) {
        return Recovery::Orphan;
    }
    match status {
        None => Recovery::Orphan,
        Some(status) => match run_end_for(status) {
            None => Recovery::Adopt,
            Some(end) => Recovery::Reclaim(end),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendState {
    /// Adopted after a restart: no send task, the run state decides.
    Adopted,
    /// `send_chat_message` has not returned yet. It awaits the whole turn.
    InFlight,
    Returned {
        ok: bool,
    },
}

/// Whether an owned run has ended, and how.
/// - A live run state never ends the run.
/// - While the send is in flight, only a chat end event ends it.
/// - A failed send, an error event or an error state is a session error.
pub fn owned_run_end(
    send: SendState,
    event_end: Option<RunEnd>,
    status: Option<RunStateStatus>,
) -> Option<RunEnd> {
    if status.is_some_and(RunStateStatus::is_live) {
        return None;
    }
    if send == (SendState::Returned { ok: false }) || event_end == Some(RunEnd::Error) {
        return Some(RunEnd::Error);
    }
    match (send, status) {
        (SendState::InFlight, _) if event_end.is_none() => None,
        (_, Some(status)) => run_end_for(status),
        // Metadata is gone. An adopted run waits; a returned send cannot be checked.
        (SendState::Adopted, None) => None,
        (_, None) => Some(RunEnd::Error),
    }
}

/// Claims `plan` into `running_dir`. When the atomic rename fails (another runner
/// took it), calls `discard` so the caller can delete the new session.
pub fn claim_or_discard(
    plan: &Path,
    running_dir: &Path,
    discard: impl FnOnce(&std::io::Error),
) -> Option<PathBuf> {
    match claim_atomic(plan, running_dir) {
        Ok(path) => Some(path),
        Err(err) => {
            discard(&err);
            None
        }
    }
}

// ---------------------------------------------------------------- state

#[derive(Debug, Clone)]
struct OwnedRun {
    worktree_id: String,
    worktree_path: PathBuf,
    plans_dir: PathBuf,
    /// The plan file in `running/`.
    plan_path: PathBuf,
    start_head: Option<String>,
    seen_running: bool,
    send: SendState,
    event_end: Option<RunEnd>,
}

#[derive(Default)]
struct QueueState {
    /// Session id → run that this runner owns.
    owned: HashMap<String, OwnedRun>,
    /// `<plans dir>/<plan name>` → "never ran" tries. Resets on restart.
    tries: HashMap<PathBuf, u32>,
    /// Worktree id → latest WAIT reason.
    wait: HashMap<String, String>,
    /// Worktree id → last SKIP line, so a skip is logged once per streak.
    skip_logged: HashMap<String, Skip>,
    /// Worktrees whose `running/` folder was already recovered.
    recovered: HashSet<String>,
}

static STATE: LazyLock<Mutex<QueueState>> = LazyLock::new(Mutex::default);
/// Serializes ticks and event-driven polls, so a run is finished once and no
/// plan starts while the previous one is being moved.
static TICK_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(tokio::sync::Mutex::default);

fn state() -> std::sync::MutexGuard<'static, QueueState> {
    STATE.lock().expect("plan queue state mutex")
}

/// The latest WAIT reason for a worktree: pending plans exist, none is ready.
pub fn wait_reason(worktree_id: &str) -> Option<String> {
    state().wait.get(worktree_id).cloned()
}

// ---------------------------------------------------------------- IO

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn git_head(worktree: &Path) -> Option<String> {
    let mut cmd = silent_command("git");
    cmd.arg("-C")
        .arg(worktree)
        .args(["rev-parse", "HEAD"])
        .stdin(std::process::Stdio::null());
    match output_with_timeout(&mut cmd, GIT_HEAD_TIMEOUT) {
        Ok((out, false)) if out.status.success() => {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|h| !h.is_empty())
        }
        _ => None,
    }
}

fn sid_path(plan: &Path) -> PathBuf {
    let mut name = plan.as_os_str().to_owned();
    name.push(".sid.txt");
    PathBuf::from(name)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn emit_changed(app: &AppHandle) {
    if let Err(e) = app.emit_all(
        "cache:invalidate",
        &serde_json::json!({ "keys": ["plan-queue"] }),
    ) {
        log::error!("plan queue: failed to emit cache:invalidate: {e}");
    }
}

/// Run state of a session: `(status, has_runs)`. `None` when metadata is missing.
fn session_run_state(app: &AppHandle, session_id: &str) -> Option<(RunStateStatus, bool)> {
    let metadata = crate::chat::storage::load_metadata(app, session_id).ok()??;
    let state = metadata.run_state(crate::chat::registry::is_session_actively_managed(
        session_id,
    ));
    Some((state.status, !metadata.runs.is_empty()))
}

fn worktree_sessions(app: &AppHandle, worktree_id: &str) -> Vec<SessionView> {
    let Ok(index) = crate::chat::storage::load_index(app, worktree_id) else {
        return Vec::new();
    };
    index
        .sessions
        .iter()
        .filter(|entry| entry.archived_at.is_none())
        .filter_map(|entry| {
            let metadata = crate::chat::storage::load_metadata(app, &entry.id).ok()??;
            let state = metadata.run_state(crate::chat::registry::is_session_actively_managed(
                &entry.id,
            ));
            Some(SessionView {
                id: entry.id.clone(),
                live: state.status.is_live(),
                mode: state.execution_mode.or(metadata.selected_execution_mode),
            })
        })
        .collect()
}

/// Moves a finished plan to its bucket and writes `.sid.txt` for done/failed.
/// `verb` is the log verb (REQUEUE, DONE, FAILED or RECLAIM).
fn move_plan(
    app: &AppHandle,
    run: &OwnedRun,
    session_id: &str,
    bucket: Bucket,
    reason: &str,
    verb: &str,
) {
    let name = file_name(&run.plan_path);
    let tries_key = run.plans_dir.join(&name);
    let _ = std::fs::remove_file(sid_path(&run.plan_path));
    if bucket == Bucket::Pending {
        *state().tries.entry(tries_key).or_insert(0) += 1;
        match move_into(&run.plan_path, &run.plans_dir) {
            Ok(_) => {
                log::info!("plan queue: {verb} {name} (session {session_id}) -> pending ({reason})")
            }
            Err(e) => log::warn!("plan queue: move {name} -> pending failed: {e}"),
        }
        emit_changed(app);
        return;
    }
    state().tries.remove(&tries_key);
    let folder = if bucket == Bucket::Done {
        "done"
    } else {
        "failed"
    };
    match move_into(&run.plan_path, &run.plans_dir.join(folder)) {
        Ok(dest) => {
            let sid = SidFile {
                session_id: session_id.to_string(),
                at: now_iso(),
                worktree: Some(run.worktree_path.to_string_lossy().into_owned()),
                head: git_head(&run.worktree_path),
                reason: Some(reason.to_string()).filter(|r| !r.is_empty()),
            };
            if let Err(e) = std::fs::write(sid_path(&dest), sid.to_string()) {
                log::warn!("plan queue: write {name}.sid.txt failed: {e}");
            }
            let suffix = if reason.is_empty() {
                String::new()
            } else {
                format!(" ({reason})")
            };
            log::info!("plan queue: {verb} {name} (session {session_id}) -> {folder}/{suffix}");
        }
        Err(e) => log::warn!("plan queue: move {name} -> {folder}/ failed: {e}"),
    }
    emit_changed(app);
}

/// Decides the outcome of an ended run and moves its plan. `reclaim` = startup
/// recovery of a run that ended while the runner was away (`seen_running` unknown).
fn finish_run(app: &AppHandle, session_id: &str, run: &OwnedRun, end: RunEnd, reclaim: bool) {
    let tries_key = run.plans_dir.join(file_name(&run.plan_path));
    let tries = state().tries.get(&tries_key).copied().unwrap_or(0);
    let seen_running = (!reclaim).then_some(run.seen_running);
    let facts = RunFacts {
        status: end,
        blocked: has_blocker_marker(&run.worktree_path),
        head: git_head(&run.worktree_path),
        start_head: run.start_head.clone(),
        seen_running,
        tries,
    };
    let (bucket, reason) = decide_outcome(&facts);
    let verb = match bucket {
        _ if reclaim => "RECLAIM",
        Bucket::Pending => "REQUEUE",
        Bucket::Done => "DONE",
        Bucket::Failed => "FAILED",
    };
    move_plan(app, run, session_id, bucket, &reason, verb);
}

/// Finishes every owned run that has ended. Caller holds [`TICK_LOCK`].
fn poll_owned(app: &AppHandle) {
    let ids: Vec<String> = state().owned.keys().cloned().collect();
    for id in ids {
        let run_state = session_run_state(app, &id);
        let finished = {
            let mut st = state();
            let Some(run) = st.owned.get_mut(&id) else {
                continue;
            };
            if let Some((status, has_runs)) = run_state {
                run.seen_running |= status.is_live() || has_runs;
            }
            match owned_run_end(run.send, run.event_end, run_state.map(|(s, _)| s)) {
                Some(end) => st.owned.remove(&id).map(|run| (run, end)),
                None => None,
            }
        };
        if let Some((run, end)) = finished {
            finish_run(app, &id, &run, end, false);
        }
    }
}

/// Adopts, reclaims or leaves the plans in `running/` that this runner does not own.
fn recover_worktree(app: &AppHandle, worktree: &Worktree) {
    let worktree_path = PathBuf::from(&worktree.path);
    let plans_dir = worktree_path.join(".jean").join("plans");
    let running_dir = plans_dir.join("running");
    for name in list_bucket(&running_dir) {
        let plan_path = running_dir.join(&name);
        if state().owned.values().any(|r| r.plan_path == plan_path) {
            continue;
        }
        let sid = std::fs::read_to_string(sid_path(&plan_path))
            .ok()
            .and_then(|text| SidFile::parse(&text).ok());
        let session_id = sid.as_ref().map(|s| s.session_id.clone());
        let status = session_id
            .as_deref()
            .and_then(|id| session_run_state(app, id))
            .map(|(status, _)| status);
        let run = OwnedRun {
            worktree_id: worktree.id.clone(),
            worktree_path: worktree_path.clone(),
            plans_dir: plans_dir.clone(),
            plan_path,
            start_head: sid.as_ref().and_then(|s| s.head.clone()),
            seen_running: true,
            send: SendState::Adopted,
            event_end: None,
        };
        let id = session_id.unwrap_or_default();
        match recovery_action(Some(id.as_str()), status) {
            Recovery::Adopt => {
                log::info!("plan queue: ADOPT {name} (session {id}) still running");
                state().owned.insert(id, run);
                emit_changed(app);
            }
            Recovery::Reclaim(end) => finish_run(app, &id, &run, end, true),
            Recovery::Orphan => {
                let id = if id.is_empty() { "no-sid" } else { id.as_str() };
                log::info!(
                    "plan queue: ORPHAN {name} (session {id}, status {status:?}) left in running/ for manual triage"
                );
            }
        }
    }
}

fn worktree_facts(app: &AppHandle, worktree: &Worktree, plans_dir: &Path) -> WorktreeFacts {
    let (owned_live, owned_plans, owned_ids) = {
        let st = state();
        (
            st.owned.values().any(|r| r.worktree_id == worktree.id),
            st.owned
                .values()
                .map(|r| r.plan_path.clone())
                .collect::<HashSet<_>>(),
            st.owned.keys().cloned().collect::<HashSet<_>>(),
        )
    };
    let running_dir = plans_dir.join("running");
    let mut facts = WorktreeFacts {
        owned_live,
        paused: plans_dir.join(PAUSED_MARKER).exists(),
        blocked: has_blocker_marker(Path::new(&worktree.path)),
        unowned_running: list_bucket(&running_dir)
            .iter()
            .any(|n| !owned_plans.contains(&running_dir.join(n))),
        foreign_live: false,
    };
    // The session scan reads every session's metadata: do it only when needed.
    if skip_reason(&facts).is_none() {
        facts.foreign_live =
            has_foreign_live_session(&worktree_sessions(app, &worktree.id), &owned_ids);
    }
    facts
}

/// Logs a SKIP once per streak. Returns true when the worktree is skipped.
fn check_skip(worktree: &Worktree, facts: &WorktreeFacts) -> bool {
    let skip = skip_reason(facts);
    let mut st = state();
    match skip {
        None => {
            st.skip_logged.remove(&worktree.id);
            false
        }
        Some(Skip::OwnedRun) => true,
        Some(skip) => {
            if st.skip_logged.insert(worktree.id.clone(), skip) != Some(skip) {
                log::info!("plan queue: SKIP {}: {}", worktree.name, skip.reason());
            }
            true
        }
    }
}

async fn maybe_start(app: &AppHandle, settings: &ProjectPlanQueueSettings, worktree: &Worktree) {
    let worktree_path = PathBuf::from(&worktree.path);
    let plans_dir = worktree_path.join(".jean").join("plans");
    let pending = list_bucket(&plans_dir);
    if pending.is_empty() {
        state().wait.remove(&worktree.id);
        return;
    }
    if check_skip(worktree, &worktree_facts(app, worktree, &plans_dir)) {
        return;
    }

    let pick = {
        let plans_dir = plans_dir.clone();
        let worktree_path = worktree_path.clone();
        // Gates may run `git show`: keep it off the async workers.
        tokio::task::spawn_blocking(move || {
            let texts = pending
                .into_iter()
                .filter_map(
                    |name| match std::fs::read_to_string(plans_dir.join(&name)) {
                        Ok(text) => Some((name, text)),
                        Err(e) => {
                            log::warn!("plan queue: read {name} failed: {e}");
                            None
                        }
                    },
                )
                .collect();
            pick_plan(texts, |text| {
                needs_met(&parse_needs(text), &plans_dir, &worktree_path)
            })
        })
        .await
    };
    let (name, text) = match pick {
        Ok(Pick::Ready { name, text }) => (name, text),
        Ok(Pick::Wait(reason)) => {
            let mut st = state();
            if st.wait.get(&worktree.id) != Some(&reason) {
                log::info!("plan queue: WAIT {}: {reason}", worktree.name);
                st.wait.insert(worktree.id.clone(), reason);
                drop(st);
                emit_changed(app);
            }
            return;
        }
        Ok(Pick::Empty) => return,
        Err(e) => {
            log::warn!("plan queue: pick failed: {e}");
            return;
        }
    };
    if state().wait.remove(&worktree.id).is_some() {
        emit_changed(app);
    }
    start_plan(app, settings, worktree, &plans_dir, &name, &text).await;
}

async fn start_plan(
    app: &AppHandle,
    settings: &ProjectPlanQueueSettings,
    worktree: &Worktree,
    plans_dir: &Path,
    name: &str,
    text: &str,
) {
    let worktree_path = PathBuf::from(&worktree.path);
    let session = match crate::chat::create_session(
        app.clone(),
        worktree.id.clone(),
        worktree.path.clone(),
        Some(name.trim_end_matches(".md").to_string()),
        Some("claude".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    {
        Ok(session) => session,
        Err(e) => {
            log::warn!("plan queue: create_session({}) failed: {e}", worktree.name);
            return;
        }
    };
    let session_id = session.id;
    let start_head = git_head(&worktree_path);

    let discard_app = app.clone();
    let discard = |err: &std::io::Error| {
        log::info!("plan queue: SKIP {name}: claim failed ({err}); deleting session {session_id}");
        let (app, wid, wpath, sid) = (
            discard_app,
            worktree.id.clone(),
            worktree.path.clone(),
            session_id.clone(),
        );
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::chat::close_session(app, wid, wpath, sid).await {
                log::warn!("plan queue: delete session after failed claim: {e}");
            }
        });
    };
    let Some(plan_path) =
        claim_or_discard(&plans_dir.join(name), &plans_dir.join("running"), discard)
    else {
        return;
    };

    let sid = SidFile {
        session_id: session_id.clone(),
        at: now_iso(),
        worktree: Some(worktree.path.clone()),
        head: start_head.clone(),
        reason: None,
    };
    if let Err(e) = std::fs::write(sid_path(&plan_path), sid.to_string()) {
        log::warn!("plan queue: write {name}.sid.txt failed: {e}");
    }
    let run = OwnedRun {
        worktree_id: worktree.id.clone(),
        worktree_path: worktree_path.clone(),
        plans_dir: plans_dir.to_path_buf(),
        plan_path,
        start_head,
        seen_running: false,
        send: SendState::InFlight,
        event_end: None,
    };
    state().owned.insert(session_id.clone(), run.clone());
    log::info!("plan queue: CLAIM {name} -> running/ (session {session_id})");
    emit_changed(app);

    let model = resolve_model(text, settings.default_model.as_deref());
    if let Some(model) = &model {
        if let Err(e) = crate::chat::set_session_model(
            app.clone(),
            worktree.id.clone(),
            worktree.path.clone(),
            session_id.clone(),
            model.clone(),
        )
        .await
        {
            // Never send a plan on another model than its pin.
            state().owned.remove(&session_id);
            let reason = format!("set_session_model {model}: {e}");
            move_plan(app, &run, &session_id, Bucket::Failed, &reason, "FAILED");
            return;
        }
        log::info!("plan queue: MODEL {name} -> {model} (session {session_id})");
    }

    set_yolo_mode(app, worktree, &session_id).await;
    log::info!(
        "plan queue: START {name} -> {} (session {session_id}, yolo)",
        worktree.name
    );
    let (app, worktree_id, worktree_path, message) = (
        app.clone(),
        worktree.id.clone(),
        worktree.path.clone(),
        text.to_string(),
    );
    tauri::async_runtime::spawn(async move {
        let result = crate::chat::send_chat_message(
            app.clone(),
            session_id.clone(),
            worktree_id,
            worktree_path,
            message,
            model,
            Some("yolo".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("claude".to_string()),
            None,
        )
        .await;
        if let Err(e) = &result {
            log::warn!("plan queue: send_chat_message({session_id}) failed: {e}");
        }
        if let Some(run) = state().owned.get_mut(&session_id) {
            run.send = SendState::Returned { ok: result.is_ok() };
        }
        let _guard = TICK_LOCK.lock().await;
        poll_owned(&app);
    });
}

/// Same session setup as Mr. Robot's yolo start: persist and broadcast the mode.
async fn set_yolo_mode(app: &AppHandle, worktree: &Worktree, session_id: &str) {
    if let Err(e) = crate::chat::update_session_state(
        app.clone(),
        worktree.id.clone(),
        worktree.path.clone(),
        session_id.to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(Some("yolo".to_string())),
        None,
        None,
        None,
        None,
    )
    .await
    {
        log::warn!("plan queue: set yolo mode on {session_id} failed: {e}");
    }
    let _ = crate::chat::broadcast_session_setting(
        app.clone(),
        session_id.to_string(),
        "executionMode".to_string(),
        "yolo".to_string(),
    )
    .await;
}

async fn tick(app: &AppHandle) {
    let _guard = TICK_LOCK.lock().await;
    poll_owned(app);
    let data = match crate::projects::storage::load_projects_data(app) {
        Ok(data) => data,
        Err(e) => {
            log::warn!("plan queue: failed to load projects data: {e}");
            return;
        }
    };
    for project in data.projects.iter().filter(|p| !p.is_folder) {
        let Some(settings) = project.plan_queue_settings.as_ref().filter(|s| s.enabled) else {
            continue;
        };
        for worktree in data.worktrees_for_project(&project.id) {
            if worktree.archived_at.is_some() {
                continue;
            }
            if state().recovered.insert(worktree.id.clone()) {
                recover_worktree(app, worktree);
            }
            maybe_start(app, settings, worktree).await;
        }
    }
}

fn session_id_of(payload: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(|id| id.as_str())
        .map(str::to_string)
}

pub fn start_plan_queue_scheduler(app: AppHandle) {
    for (event_name, end) in [
        ("chat:done", RunEnd::Done),
        ("chat:error", RunEnd::Error),
        ("chat:cancelled", RunEnd::Error),
    ] {
        let listen_app = app.clone();
        app.listen(event_name, move |event| {
            let Some(session_id) = session_id_of(event.payload()) else {
                return;
            };
            {
                let mut st = state();
                let Some(run) = st.owned.get_mut(&session_id) else {
                    return;
                };
                if run.event_end != Some(RunEnd::Error) {
                    run.event_end = Some(end);
                }
            }
            let app = listen_app.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = TICK_LOCK.lock().await;
                poll_owned(&app);
            });
        });
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tick(&app).await;
            tokio::time::sleep(Duration::from_secs(TICK_SECONDS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn met() -> GateResult {
        GateResult {
            met: true,
            reason: String::new(),
        }
    }

    fn wait(reason: &str) -> GateResult {
        GateResult {
            met: false,
            reason: reason.to_string(),
        }
    }

    fn plans(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(n, t)| (n.to_string(), t.to_string()))
            .collect()
    }

    #[test]
    fn no_fact_means_no_skip() {
        assert_eq!(skip_reason(&WorktreeFacts::default()), None);
    }

    #[test]
    fn each_fact_skips_the_worktree() {
        let cases = [
            (
                WorktreeFacts {
                    owned_live: true,
                    ..Default::default()
                },
                Skip::OwnedRun,
            ),
            (
                WorktreeFacts {
                    paused: true,
                    ..Default::default()
                },
                Skip::Paused,
            ),
            (
                WorktreeFacts {
                    blocked: true,
                    ..Default::default()
                },
                Skip::Blocked,
            ),
            (
                WorktreeFacts {
                    unowned_running: true,
                    ..Default::default()
                },
                Skip::UnownedRunning,
            ),
            (
                WorktreeFacts {
                    foreign_live: true,
                    ..Default::default()
                },
                Skip::ForeignSession,
            ),
        ];
        for (facts, want) in cases {
            assert_eq!(skip_reason(&facts), Some(want), "{facts:?}");
        }
    }

    #[test]
    fn owned_run_wins_over_other_skips() {
        let facts = WorktreeFacts {
            owned_live: true,
            paused: true,
            blocked: true,
            unowned_running: true,
            foreign_live: true,
        };
        assert_eq!(skip_reason(&facts), Some(Skip::OwnedRun));
    }

    fn session(id: &str, live: bool, mode: Option<&str>) -> SessionView {
        SessionView {
            id: id.to_string(),
            live,
            mode: mode.map(str::to_string),
        }
    }

    #[test]
    fn only_foreign_live_build_or_yolo_sessions_block() {
        let owned: HashSet<String> = ["mine".to_string()].into();
        let blocking = [
            session("a", true, Some("build")),
            session("b", true, Some("YOLO")),
        ];
        for s in blocking {
            assert!(has_foreign_live_session(&[s.clone()], &owned), "{s:?}");
        }
        let not_blocking = [
            session("mine", true, Some("yolo")),
            session("a", false, Some("yolo")),
            session("a", true, Some("plan")),
            session("a", true, None),
        ];
        for s in not_blocking {
            assert!(!has_foreign_live_session(&[s.clone()], &owned), "{s:?}");
        }
    }

    #[test]
    fn pick_takes_the_first_plan_with_a_met_gate() {
        let pending = plans(&[("001-a.md", "A"), ("002-b.md", "B"), ("003-c.md", "C")]);
        let pick = pick_plan(pending, |t| {
            if t == "A" {
                wait("slice x not in done/")
            } else {
                met()
            }
        });
        assert_eq!(
            pick,
            Pick::Ready {
                name: "002-b.md".into(),
                text: "B".into()
            }
        );
    }

    #[test]
    fn pick_waits_with_the_first_reason_when_none_is_ready() {
        let pending = plans(&[("001-a.md", "A"), ("002-b.md", "B")]);
        let pick = pick_plan(pending, |t| wait(&format!("gate {t}")));
        assert_eq!(
            pick,
            Pick::Wait("2 pending, none ready (001-a.md: gate A)".into())
        );
    }

    #[test]
    fn pick_of_no_plans_is_empty() {
        assert_eq!(pick_plan(Vec::new(), |_| met()), Pick::Empty);
    }

    #[test]
    fn model_pin_wins_then_default_then_none() {
        let pinned = "<!-- model: claude-sonnet-5-5 -->\n# Plan\n";
        assert_eq!(
            resolve_model(pinned, Some("claude-opus-5-5")).as_deref(),
            Some("claude-sonnet-5-5")
        );
        assert_eq!(
            resolve_model("# Plan\n", Some("claude-opus-5-5")).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(resolve_model("# Plan\n", None), None);
        assert_eq!(resolve_model("# Plan\n", Some("  ")), None);
        // Only line 1 counts.
        assert_eq!(resolve_model("# Plan\n<!-- model: x -->\n", None), None);
    }

    #[test]
    fn recovery_action_for_each_run_state() {
        use RunStateStatus::*;
        let cases = [
            (Running, Recovery::Adopt),
            (Resumable, Recovery::Adopt),
            (Idle, Recovery::Reclaim(RunEnd::Done)),
            (Error, Recovery::Reclaim(RunEnd::Error)),
            (Cancelled, Recovery::Reclaim(RunEnd::Error)),
        ];
        for (status, want) in cases {
            assert_eq!(
                recovery_action(Some("s1"), Some(status)),
                want,
                "{status:?}"
            );
        }
    }

    #[test]
    fn recovery_without_sid_or_state_is_orphan() {
        assert_eq!(
            recovery_action(None, Some(RunStateStatus::Idle)),
            Recovery::Orphan
        );
        assert_eq!(
            recovery_action(Some(""), Some(RunStateStatus::Idle)),
            Recovery::Orphan
        );
        assert_eq!(recovery_action(Some("s1"), None), Recovery::Orphan);
    }

    #[test]
    fn live_run_never_ends() {
        for send in [
            SendState::Adopted,
            SendState::InFlight,
            SendState::Returned { ok: false },
        ] {
            assert_eq!(
                owned_run_end(send, Some(RunEnd::Error), Some(RunStateStatus::Running)),
                None
            );
        }
    }

    #[test]
    fn in_flight_send_waits_for_an_end_event() {
        let idle = Some(RunStateStatus::Idle);
        // Pre-start: the run state is still idle, the send is pending.
        assert_eq!(owned_run_end(SendState::InFlight, None, idle), None);
        assert_eq!(
            owned_run_end(SendState::InFlight, Some(RunEnd::Done), idle),
            Some(RunEnd::Done)
        );
        assert_eq!(
            owned_run_end(SendState::InFlight, Some(RunEnd::Error), idle),
            Some(RunEnd::Error)
        );
    }

    #[test]
    fn returned_send_ends_by_run_state() {
        let ok = SendState::Returned { ok: true };
        assert_eq!(
            owned_run_end(ok, None, Some(RunStateStatus::Idle)),
            Some(RunEnd::Done)
        );
        assert_eq!(
            owned_run_end(ok, None, Some(RunStateStatus::Error)),
            Some(RunEnd::Error)
        );
        assert_eq!(
            owned_run_end(ok, None, Some(RunStateStatus::Cancelled)),
            Some(RunEnd::Error)
        );
        assert_eq!(owned_run_end(ok, None, None), Some(RunEnd::Error));
        assert_eq!(
            owned_run_end(
                SendState::Returned { ok: false },
                None,
                Some(RunStateStatus::Idle)
            ),
            Some(RunEnd::Error)
        );
    }

    #[test]
    fn adopted_run_ends_by_run_state() {
        let adopted = SendState::Adopted;
        assert_eq!(
            owned_run_end(adopted, None, Some(RunStateStatus::Idle)),
            Some(RunEnd::Done)
        );
        assert_eq!(owned_run_end(adopted, None, None), None);
    }

    #[test]
    fn failed_claim_discards_the_session_and_skips() {
        let dir = tempfile::tempdir().unwrap();
        let running = dir.path().join("running");
        let plan = dir.path().join("001-a.md");
        std::fs::write(&plan, "x").unwrap();

        let discarded = Cell::new(0);
        let claimed = claim_or_discard(&plan, &running, |_| discarded.set(discarded.get() + 1));
        assert_eq!(claimed, Some(running.join("001-a.md")));
        assert_eq!(discarded.get(), 0);

        // Another runner already took the file.
        let claimed = claim_or_discard(&plan, &running, |_| discarded.set(discarded.get() + 1));
        assert_eq!(claimed, None);
        assert_eq!(discarded.get(), 1);
        assert!(running.join("001-a.md").exists());
    }

    #[test]
    fn sid_path_appends_the_suffix() {
        assert_eq!(
            sid_path(Path::new("plans/running/001-a.md")),
            PathBuf::from("plans/running/001-a.md.sid.txt")
        );
    }
}
