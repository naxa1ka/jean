//! Queue commands: read and control a worktree's `.jean/plans/` queue.
//!
//! Every command resolves the worktree path from its id through Jean's own
//! project data, never from client input. The file logic lives in functions
//! that take the resolved worktree path, so tests need no app context.
//!
//! Rules for every mutation:
//! - a plan `name` must pass [`validate_plan_name`] and be a file in the bucket
//!   that the action reads from;
//! - a plan in `running/` is never touched;
//! - only paths inside `<worktree>/.jean/` are read or written.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::files::{list_bucket, next_prefix, slugify, validate_plan_name, SidFile};
use super::gates::{needs_met, parse_needs, strip_num_prefix};
use super::scheduler::{
    is_paused, lock_queue, owned_running_plans, resolve_model, sid_path, wait_reason, PAUSED_MARKER,
};
use crate::projects::types::ProjectsData;

/// Largest plan text that `plan_queue_add` accepts.
pub const MAX_PLAN_BYTES: usize = 1024 * 1024;
/// Bytes read from a plan to find its title, model pin and gate lines.
const HEADER_BYTES: u64 = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePlan {
    pub name: String,
    /// The first `# ` heading, else the file name without `.md`.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_pin: Option<String>,
    /// Pending plans only: why the gate is not met yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningPlan {
    #[serde(flatten)]
    pub plan: QueuePlan,
    pub session_id: String,
    /// `at` from `.sid.txt`, when the file has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DonePlan {
    #[serde(flatten)]
    pub plan: QueuePlan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedPlan {
    #[serde(flatten)]
    pub plan: QueuePlan,
    /// From `.sid.txt`. Empty when the file has no reason.
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanQueue {
    pub paused: bool,
    /// File names in `.jean/blocked/` (only `*.md` counts).
    pub blocked: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
    pub pending: Vec<QueuePlan>,
    /// Plans in `running/` that the runner owns.
    pub running: Vec<RunningPlan>,
    pub done: Vec<DonePlan>,
    pub failed: Vec<FailedPlan>,
    /// Plans in `paused/`, out of the queue.
    pub skipped: Vec<QueuePlan>,
    /// Plans in `running/` that the runner does not own.
    pub orphans: Vec<QueuePlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanQueueSummary {
    pub worktree_id: String,
    pub pending: usize,
    pub done_count: usize,
    /// pending + running + done + failed.
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_since: Option<String>,
    pub paused: bool,
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanQueueAction {
    Pause,
    Resume,
    /// failed/ → pending, at the end.
    Retry,
    /// pending → paused/.
    Skip,
    /// paused/ → pending, at the end.
    Unskip,
    /// Deletes a pending plan.
    Remove,
    /// Deletes the `*.md` files directly inside `.jean/blocked/`.
    ClearBlocked,
}

// ---------------------------------------------------------------- paths

fn plans_dir(worktree: &Path) -> PathBuf {
    worktree.join(".jean").join("plans")
}

fn blocked_dir(worktree: &Path) -> PathBuf {
    worktree.join(".jean").join("blocked")
}

/// The worktree path that Jean stores for `worktree_id`. Unknown ids are an error.
pub fn resolve_worktree_path(data: &ProjectsData, worktree_id: &str) -> Result<PathBuf, String> {
    data.find_worktree(worktree_id)
        .map(|w| PathBuf::from(&w.path))
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))
}

fn resolve(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    let data = crate::projects::storage::load_projects_data(app)?;
    resolve_worktree_path(&data, worktree_id)
}

// ---------------------------------------------------------------- read

fn read_header(path: &Path) -> String {
    let mut bytes = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(HEADER_BYTES).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn read_sid(plan: &Path) -> Option<SidFile> {
    let text = fs::read_to_string(sid_path(plan)).ok()?;
    SidFile::parse(&text).ok()
}

/// Title, model pin and (when `gate_for` is set) the unmet gate of one plan.
fn read_plan(dir: &Path, name: &str, gate_for: Option<&Path>) -> QueuePlan {
    let header = read_header(&dir.join(name));
    let title = header
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
    let gate = gate_for.and_then(|worktree| {
        let result = needs_met(&parse_needs(&header), dir, worktree);
        (!result.met).then_some(result.reason)
    });
    QueuePlan {
        name: name.to_string(),
        title,
        model_pin: resolve_model(&header, None),
        gate,
    }
}

/// The whole queue of one worktree. `owned` maps owned `running/` plan paths to
/// their session ids. Pending gates may run `git show`: call off async workers.
pub fn read_queue(
    worktree: &Path,
    owned: &HashMap<PathBuf, String>,
    wait_reason: Option<String>,
) -> PlanQueue {
    let plans = plans_dir(worktree);
    let running_dir = plans.join("running");
    let done_dir = plans.join("done");
    let failed_dir = plans.join("failed");
    let paused_dir = plans.join("paused");

    let mut queue = PlanQueue {
        paused: is_paused(&plans),
        blocked: list_bucket(&blocked_dir(worktree)),
        wait_reason,
        pending: list_bucket(&plans)
            .iter()
            .map(|n| read_plan(&plans, n, Some(worktree)))
            .collect(),
        skipped: list_bucket(&paused_dir)
            .iter()
            .map(|n| read_plan(&paused_dir, n, None))
            .collect(),
        ..PlanQueue::default()
    };
    for name in list_bucket(&running_dir) {
        let path = running_dir.join(&name);
        let plan = read_plan(&running_dir, &name, None);
        match owned.get(&path) {
            Some(session_id) => queue.running.push(RunningPlan {
                plan,
                session_id: session_id.clone(),
                started_at: read_sid(&path).map(|s| s.at).filter(|a| !a.is_empty()),
            }),
            None => queue.orphans.push(plan),
        }
    }
    for name in list_bucket(&done_dir) {
        let sid = read_sid(&done_dir.join(&name));
        queue.done.push(DonePlan {
            plan: read_plan(&done_dir, &name, None),
            session_id: sid.map(|s| s.session_id),
        });
    }
    for name in list_bucket(&failed_dir) {
        let sid = read_sid(&failed_dir.join(&name));
        queue.failed.push(FailedPlan {
            plan: read_plan(&failed_dir, &name, None),
            reason: sid
                .as_ref()
                .and_then(|s| s.reason.clone())
                .unwrap_or_default(),
            session_id: sid.map(|s| s.session_id),
        });
    }
    queue
}

/// Counts for the progress line. `None` when the worktree has no plans folder.
pub fn summarize(
    worktree_id: &str,
    worktree: &Path,
    wait_reason: Option<String>,
) -> Option<PlanQueueSummary> {
    let plans = plans_dir(worktree);
    if !plans.is_dir() {
        return None;
    }
    let pending = list_bucket(&plans).len();
    let running = list_bucket(&plans.join("running"));
    let done_count = list_bucket(&plans.join("done")).len();
    let failed = list_bucket(&plans.join("failed")).len();
    let running_since = running
        .first()
        .and_then(|n| read_sid(&plans.join("running").join(n)))
        .map(|s| s.at)
        .filter(|a| !a.is_empty());
    Some(PlanQueueSummary {
        worktree_id: worktree_id.to_string(),
        pending,
        done_count,
        total: pending + running.len() + done_count + failed,
        running_plan: running.first().cloned(),
        running_since,
        paused: is_paused(&plans),
        blocked: !list_bucket(&blocked_dir(worktree)).is_empty(),
        wait_reason,
    })
}

// ---------------------------------------------------------------- mutate

/// Checks `name` and that it is a plan file in `dir`, never one in `running/`.
fn plan_in(worktree: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    validate_plan_name(name)?;
    if plans_dir(worktree).join("running").join(name).exists() {
        return Err(format!("{name} is running; it cannot be changed"));
    }
    if !list_bucket(dir).iter().any(|n| n == name) {
        return Err(format!("plan not found: {name}"));
    }
    Ok(dir.join(name))
}

/// Rename, else copy + delete. Never overwrites `dest`.
fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(src, dest).is_err() {
        fs::copy(src, dest).map_err(|e| e.to_string())?;
        fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Moves a plan back to the end of the pending queue with the next prefix.
fn requeue(worktree: &Path, src: &Path, name: &str) -> Result<(), String> {
    let plans = plans_dir(worktree);
    let new_name = format!("{}-{}", next_prefix(&plans), strip_num_prefix(name));
    validate_plan_name(&new_name)?;
    move_file(src, &plans.join(new_name))
}

/// Writes `NNN-<slug>.md` at the end of the queue. Returns the file name.
pub fn add_plan(worktree: &Path, name: &str, content: &str) -> Result<String, String> {
    if content.len() > MAX_PLAN_BYTES {
        return Err("plan text is larger than 1 MB".to_string());
    }
    if content.trim().is_empty() {
        return Err("plan text is empty".to_string());
    }
    let base = name.trim();
    let base = if base.to_ascii_lowercase().ends_with(".md") {
        &base[..base.len() - 3]
    } else {
        base
    };
    let plans = plans_dir(worktree);
    let file_name = format!(
        "{}-{}.md",
        next_prefix(&plans),
        slugify(strip_num_prefix(base.trim()))
    );
    validate_plan_name(&file_name)?;
    fs::create_dir_all(&plans).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(plans.join(&file_name))
        .map_err(|e| format!("cannot write {file_name}: {e}"))?;
    io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(file_name)
}

/// Renames the pending plans to `001…` in `names` order. The set must equal
/// the current pending set. On an IO error, the renames done so far are undone.
pub fn reorder_plans(worktree: &Path, names: &[String]) -> Result<(), String> {
    let plans = plans_dir(worktree);
    for name in names {
        validate_plan_name(name)?;
        if plans.join("running").join(name).exists() {
            return Err(format!("{name} is running; it cannot be reordered"));
        }
    }
    let renames = super::files::reorder_renames(&list_bucket(&plans), names)?;
    for (i, (from, to)) in renames.iter().enumerate() {
        if let Err(e) = fs::rename(plans.join(from), plans.join(to)) {
            for (from, to) in renames[..i].iter().rev() {
                let _ = fs::rename(plans.join(to), plans.join(from));
            }
            return Err(format!("reorder failed at {from}: {e}"));
        }
    }
    Ok(())
}

pub fn apply_action(
    worktree: &Path,
    action: PlanQueueAction,
    name: Option<&str>,
) -> Result<(), String> {
    let plans = plans_dir(worktree);
    let need_name = || name.ok_or_else(|| "this action needs a plan name".to_string());
    match action {
        PlanQueueAction::Pause => {
            fs::create_dir_all(&plans).map_err(|e| e.to_string())?;
            fs::write(plans.join(PAUSED_MARKER), "").map_err(|e| e.to_string())
        }
        PlanQueueAction::Resume => match fs::remove_file(plans.join(PAUSED_MARKER)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
        PlanQueueAction::Retry => {
            let name = need_name()?;
            let src = plan_in(worktree, &plans.join("failed"), name)?;
            requeue(worktree, &src, name)?;
            let _ = fs::remove_file(sid_path(&src));
            Ok(())
        }
        PlanQueueAction::Skip => {
            let name = need_name()?;
            let src = plan_in(worktree, &plans, name)?;
            move_file(&src, &plans.join("paused").join(name))
        }
        PlanQueueAction::Unskip => {
            let name = need_name()?;
            let src = plan_in(worktree, &plans.join("paused"), name)?;
            requeue(worktree, &src, name)
        }
        PlanQueueAction::Remove => {
            let name = need_name()?;
            let src = plan_in(worktree, &plans, name)?;
            fs::remove_file(src).map_err(|e| e.to_string())
        }
        PlanQueueAction::ClearBlocked => {
            let blocked = blocked_dir(worktree);
            // `list_bucket` returns only regular `*.md` files directly inside.
            for file in list_bucket(&blocked) {
                fs::remove_file(blocked.join(&file))
                    .map_err(|e| format!("cannot delete {file}: {e}"))?;
            }
            Ok(())
        }
    }
}

// ---------------------------------------------------------------- commands

pub async fn get_plan_queue(app: &AppHandle, worktree_id: String) -> Result<PlanQueue, String> {
    let worktree = resolve(app, &worktree_id)?;
    let owned = owned_running_plans();
    let wait = wait_reason(&worktree_id);
    tokio::task::spawn_blocking(move || read_queue(&worktree, &owned, wait))
        .await
        .map_err(|e| e.to_string())
}

pub async fn get_plan_queue_summaries(
    app: &AppHandle,
    project_id: String,
) -> Result<Vec<PlanQueueSummary>, String> {
    let data = crate::projects::storage::load_projects_data(app)?;
    if data.find_project(&project_id).is_none() {
        return Err(format!("Project not found: {project_id}"));
    }
    let worktrees: Vec<(String, PathBuf)> = data
        .worktrees_for_project(&project_id)
        .into_iter()
        .filter(|w| w.archived_at.is_none())
        .map(|w| (w.id.clone(), PathBuf::from(&w.path)))
        .collect();
    tokio::task::spawn_blocking(move || {
        worktrees
            .iter()
            .filter_map(|(id, path)| summarize(id, path, wait_reason(id)))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

pub async fn plan_queue_add(
    app: &AppHandle,
    worktree_id: String,
    name: String,
    content: String,
) -> Result<String, String> {
    let worktree = resolve(app, &worktree_id)?;
    let _guard = lock_queue().await;
    add_plan(&worktree, &name, &content)
}

pub async fn plan_queue_reorder(
    app: &AppHandle,
    worktree_id: String,
    names: Vec<String>,
) -> Result<(), String> {
    let worktree = resolve(app, &worktree_id)?;
    let _guard = lock_queue().await;
    reorder_plans(&worktree, &names)
}

pub async fn plan_queue_action(
    app: &AppHandle,
    worktree_id: String,
    action: PlanQueueAction,
    name: Option<String>,
) -> Result<(), String> {
    let worktree = resolve(app, &worktree_id)?;
    let _guard = lock_queue().await;
    apply_action(&worktree, action, name.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Wt(tempfile::TempDir);

    impl Wt {
        fn new() -> Self {
            let wt = Wt(tempfile::tempdir().unwrap());
            fs::create_dir_all(wt.plans()).unwrap();
            wt
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
        fn plans(&self) -> PathBuf {
            plans_dir(self.path())
        }
        fn put(&self, rel: &str, text: &str) {
            let path = self.plans().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn bucket(&self, rel: &str) -> Vec<String> {
            list_bucket(&self.plans().join(rel))
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn unknown_worktree_id_is_rejected() {
        let err = resolve_worktree_path(&ProjectsData::default(), "nope").unwrap_err();
        assert!(err.contains("Worktree not found"), "{err}");
    }

    #[test]
    fn pause_and_resume_toggle_the_marker() {
        let wt = Wt::new();
        // A `paused/` folder of skipped plans is not the pause marker.
        wt.put("paused/001-a.md", "a");
        assert!(!is_paused(&wt.plans()));
        apply_action(wt.path(), PlanQueueAction::Pause, None).unwrap();
        assert!(is_paused(&wt.plans()));
        apply_action(wt.path(), PlanQueueAction::Resume, None).unwrap();
        assert!(!is_paused(&wt.plans()));
        // Resume without a marker is a no-op.
        apply_action(wt.path(), PlanQueueAction::Resume, None).unwrap();
    }

    #[test]
    fn retry_moves_failed_to_the_end_and_drops_the_sid() {
        let wt = Wt::new();
        wt.put("003-c.md", "c");
        wt.put("failed/001-a.md", "a");
        wt.put("failed/001-a.md.sid.txt", "sessionId=s\nat=t\nreason=r\n");
        apply_action(wt.path(), PlanQueueAction::Retry, Some("001-a.md")).unwrap();
        assert_eq!(wt.bucket(""), names(&["003-c.md", "004-a.md"]));
        assert!(wt.bucket("failed").is_empty());
        assert!(!wt.plans().join("failed/001-a.md.sid.txt").exists());
    }

    #[test]
    fn skip_and_unskip_move_between_pending_and_paused() {
        let wt = Wt::new();
        wt.put("001-a.md", "a");
        wt.put("002-b.md", "b");
        apply_action(wt.path(), PlanQueueAction::Skip, Some("001-a.md")).unwrap();
        assert_eq!(wt.bucket(""), names(&["002-b.md"]));
        assert_eq!(wt.bucket("paused"), names(&["001-a.md"]));
        apply_action(wt.path(), PlanQueueAction::Unskip, Some("001-a.md")).unwrap();
        assert_eq!(wt.bucket(""), names(&["002-b.md", "003-a.md"]));
        assert!(wt.bucket("paused").is_empty());
    }

    #[test]
    fn remove_deletes_only_a_pending_plan() {
        let wt = Wt::new();
        wt.put("001-a.md", "a");
        wt.put("done/002-b.md", "b");
        apply_action(wt.path(), PlanQueueAction::Remove, Some("001-a.md")).unwrap();
        assert!(wt.bucket("").is_empty());
        assert!(apply_action(wt.path(), PlanQueueAction::Remove, Some("002-b.md")).is_err());
        assert_eq!(wt.bucket("done"), names(&["002-b.md"]));
    }

    #[test]
    fn name_actions_need_a_name() {
        let wt = Wt::new();
        for action in [
            PlanQueueAction::Retry,
            PlanQueueAction::Skip,
            PlanQueueAction::Unskip,
            PlanQueueAction::Remove,
        ] {
            assert!(apply_action(wt.path(), action, None).is_err(), "{action:?}");
        }
    }

    #[test]
    fn running_plans_are_refused() {
        let wt = Wt::new();
        wt.put("running/001-a.md", "a");
        // Same name also in the source bucket: the running copy still wins.
        wt.put("001-a.md", "a");
        wt.put("failed/001-a.md", "a");
        for action in [
            PlanQueueAction::Retry,
            PlanQueueAction::Skip,
            PlanQueueAction::Remove,
        ] {
            let err = apply_action(wt.path(), action, Some("001-a.md")).unwrap_err();
            assert!(err.contains("running"), "{action:?}: {err}");
        }
        assert!(reorder_plans(wt.path(), &names(&["001-a.md"])).is_err());
        assert_eq!(wt.bucket("running"), names(&["001-a.md"]));
        assert_eq!(wt.bucket(""), names(&["001-a.md"]));
    }

    #[test]
    fn path_traversal_names_are_rejected() {
        let wt = Wt::new();
        // A plan outside the bucket that a traversal name would reach.
        fs::write(wt.path().join("victim.md"), "x").unwrap();
        for bad in [
            "../../victim.md",
            "..\\..\\victim.md",
            "/etc/x.md",
            "C:x.md",
        ] {
            for action in [
                PlanQueueAction::Retry,
                PlanQueueAction::Skip,
                PlanQueueAction::Unskip,
                PlanQueueAction::Remove,
            ] {
                assert!(apply_action(wt.path(), action, Some(bad)).is_err(), "{bad}");
            }
            assert!(reorder_plans(wt.path(), &names(&[bad])).is_err(), "{bad}");
        }
        assert!(wt.path().join("victim.md").exists());
    }

    #[test]
    fn clear_blocked_deletes_only_md_files_and_keeps_gitkeep() {
        let wt = Wt::new();
        let blocked = blocked_dir(wt.path());
        fs::create_dir_all(blocked.join("sub")).unwrap();
        for f in [
            "BLOCKED-03.md",
            "x.MD",
            ".gitkeep",
            "notes.txt",
            "sub/deep.md",
        ] {
            fs::write(blocked.join(f), "x").unwrap();
        }
        apply_action(wt.path(), PlanQueueAction::ClearBlocked, None).unwrap();
        assert!(!blocked.join("BLOCKED-03.md").exists());
        assert!(!blocked.join("x.MD").exists());
        assert!(blocked.join(".gitkeep").exists());
        assert!(blocked.join("notes.txt").exists());
        assert!(blocked.join("sub/deep.md").exists());
    }

    #[test]
    fn reorder_renumbers_and_rejects_a_wrong_set() {
        let wt = Wt::new();
        wt.put("001-a.md", "a");
        wt.put("002-b.md", "b");
        assert!(reorder_plans(wt.path(), &names(&["001-a.md"])).is_err());
        assert!(reorder_plans(wt.path(), &names(&["001-a.md", "009-x.md"])).is_err());
        assert_eq!(wt.bucket(""), names(&["001-a.md", "002-b.md"]));
        reorder_plans(wt.path(), &names(&["002-b.md", "001-a.md"])).unwrap();
        assert_eq!(wt.bucket(""), names(&["001-b.md", "002-a.md"]));
        assert_eq!(
            fs::read_to_string(wt.plans().join("001-b.md")).unwrap(),
            "b"
        );
    }

    #[test]
    fn add_slugifies_appends_and_caps_the_size() {
        let wt = Wt::new();
        wt.put("004-x.md", "x");
        let name = add_plan(wt.path(), "  007-My Plan: UI!.MD ", "# Title\nbody").unwrap();
        assert_eq!(name, "005-my-plan-ui.md");
        assert_eq!(
            fs::read_to_string(wt.plans().join(&name)).unwrap(),
            "# Title\nbody"
        );
        // `..` survives slugify, so the final name check rejects it.
        assert!(add_plan(wt.path(), "../evil", "x").is_err());
        assert!(add_plan(wt.path(), "big", &"x".repeat(MAX_PLAN_BYTES + 1)).is_err());
        assert!(add_plan(wt.path(), "empty", "  \n").is_err());
        assert_eq!(fs::read_dir(wt.path()).unwrap().count(), 1); // only .jean
    }

    #[test]
    fn read_queue_sorts_plans_into_buckets() {
        let wt = Wt::new();
        wt.put("001-a.md", "<!-- model: claude-x -->\n# Alpha\n");
        wt.put("002-b.md", "<!-- needs-slice: zzz -->\nbody");
        wt.put("running/003-c.md", "c");
        wt.put("running/003-c.md.sid.txt", "sessionId=s3\nat=t3\n");
        wt.put("running/004-d.md", "d");
        wt.put("done/000-e.md", "e");
        wt.put("done/000-e.md.sid.txt", "sessionId=s0\nat=t\n");
        wt.put("failed/005-f.md", "f");
        wt.put(
            "failed/005-f.md.sid.txt",
            "sessionId=s5\nat=t\nreason=no new commit\n",
        );
        wt.put("paused/006-g.md", "g");
        wt.put(PAUSED_MARKER, "");
        fs::create_dir_all(blocked_dir(wt.path())).unwrap();
        fs::write(blocked_dir(wt.path()).join("B.md"), "x").unwrap();

        let owned = HashMap::from([(wt.plans().join("running/003-c.md"), "s3".to_string())]);
        let q = read_queue(wt.path(), &owned, Some("wait".into()));
        assert!(q.paused);
        assert_eq!(q.blocked, names(&["B.md"]));
        assert_eq!(q.wait_reason.as_deref(), Some("wait"));
        assert_eq!(q.pending[0].title, "Alpha");
        assert_eq!(q.pending[0].model_pin.as_deref(), Some("claude-x"));
        assert_eq!(q.pending[0].gate, None);
        assert_eq!(q.pending[1].title, "002-b");
        assert_eq!(q.pending[1].gate.as_deref(), Some("slice zzz not in done/"));
        assert_eq!(q.running.len(), 1);
        assert_eq!(q.running[0].session_id, "s3");
        assert_eq!(q.running[0].started_at.as_deref(), Some("t3"));
        assert_eq!(q.orphans[0].name, "004-d.md");
        assert_eq!(q.done[0].session_id.as_deref(), Some("s0"));
        assert_eq!(q.failed[0].reason, "no new commit");
        assert_eq!(q.skipped[0].name, "006-g.md");

        let json = serde_json::to_value(&q).unwrap();
        assert_eq!(json["pending"][0]["modelPin"], "claude-x");
        assert_eq!(json["running"][0]["sessionId"], "s3");
        assert_eq!(json["running"][0]["name"], "003-c.md");
        assert_eq!(json["waitReason"], "wait");
    }

    #[test]
    fn summary_counts_the_buckets() {
        let wt = Wt::new();
        wt.put("001-a.md", "a");
        wt.put("002-b.md", "b");
        wt.put("running/003-c.md", "c");
        wt.put("running/003-c.md.sid.txt", "sessionId=s\nat=t3\n");
        wt.put("done/000-d.md", "d");
        wt.put("failed/004-e.md", "e");
        wt.put("paused/005-f.md", "f");
        let s = summarize("w1", wt.path(), None).unwrap();
        assert_eq!(
            s,
            PlanQueueSummary {
                worktree_id: "w1".into(),
                pending: 2,
                done_count: 1,
                total: 5,
                running_plan: Some("003-c.md".into()),
                running_since: Some("t3".into()),
                paused: false,
                blocked: false,
                wait_reason: None,
            }
        );
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(summarize("w2", empty.path(), None), None);
    }

    #[test]
    fn actions_deserialize_from_snake_case() {
        let a: PlanQueueAction = serde_json::from_str("\"clear_blocked\"").unwrap();
        assert_eq!(a, PlanQueueAction::ClearBlocked);
        assert!(serde_json::from_str::<PlanQueueAction>("\"delete_all\"").is_err());
    }
}
