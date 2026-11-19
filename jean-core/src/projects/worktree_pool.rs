//! Per-project pool of ready worktrees.
//!
//! When a project turns the pool on, a background maintainer keeps idle worktrees
//! (`git worktree add` and the `jean.json` setup script done) in
//! `<app_data>/worktree_pool.json`. Pool worktrees are not in `projects.json`, so
//! the sidebar, lists, MCP, and auto-fix do not see them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use super::commands::{resolve_start_point, sanitize_folder_name};
use super::git;
use super::names::generate_unique_workspace_name;
use super::storage::{get_project_worktrees_dir, load_projects_data};
use super::types::{Project, ProjectWorktreePoolSettings};

const POOL_FILE: &str = "worktree_pool.json";
const MAINTAINER_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Serializes read-modify-write of `worktree_pool.json`.
static POOL_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// State of a running reconcile.
#[derive(Debug, Default)]
struct FillState {
    /// Worktrees still to create.
    count: u32,
    /// Another reconcile was asked for while this one runs.
    dirty: bool,
}

/// Project id -> state. A key is present while a reconcile runs.
static FILLING: Lazy<Mutex<HashMap<String, FillState>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// One worktree of the pool. It is idle (ready to take) unless `busy` is set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PoolEntry {
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base_branch: String,
    pub created_at: u64,
    #[serde(default)]
    pub setup_script: Option<String>,
    #[serde(default)]
    pub setup_output: Option<String>,
    #[serde(default)]
    pub setup_success: Option<bool>,
    /// Not idle: being set up, claimed by a new worktree, or being removed. The entry
    /// stays in the file until that ends, so a crash leaves a trace that
    /// `cleanup_stale_entries` finds at the next start.
    #[serde(default)]
    pub busy: bool,
}

/// Contents of `<app_data>/worktree_pool.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct WorktreePoolData {
    #[serde(default)]
    pub entries: Vec<PoolEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePoolStatus {
    pub idle: u32,
    pub filling: u32,
}

/// Worktrees to create now. Refill starts when idle worktrees drop below
/// `min_idle` and fills up to `max_idle`, counting worktrees already in creation.
pub fn refill_needed(idle: u32, filling: u32, s: &ProjectWorktreePoolSettings) -> u32 {
    if !s.enabled || idle >= s.min_idle {
        return 0;
    }
    s.max_idle.saturating_sub(idle + filling)
}

/// Idle worktrees to remove now. A disabled pool removes all of them.
pub fn trim_needed(idle: u32, s: &ProjectWorktreePoolSettings) -> u32 {
    if !s.enabled {
        return idle;
    }
    idle.saturating_sub(s.max_idle)
}

fn pool_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(dir.join(POOL_FILE))
}

fn load_pool(path: &Path) -> Result<WorktreePoolData, String> {
    if !path.exists() {
        return Ok(WorktreePoolData::default());
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if contents.trim().is_empty() {
        return Ok(WorktreePoolData::default());
    }
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

/// Atomic read-modify-write of the pool file. A missing file is an empty pool.
pub fn with_pool_mut<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut WorktreePoolData) -> R,
) -> Result<R, String> {
    let _lock = POOL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = pool_path(app)?;
    let mut data = load_pool(&path)?;
    let output = f(&mut data);
    let json = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize worktree pool: {e}"))?;
    crate::platform::write_file_atomically(&path, json.as_bytes())?;
    Ok(output)
}

fn read_pool(app: &AppHandle) -> Result<WorktreePoolData, String> {
    let _lock = POOL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_pool(&pool_path(app)?)
}

/// Drop entries whose folder no longer exists (deleted outside Jean), with their branch.
pub fn drop_missing_entries(app: &AppHandle) -> Result<(), String> {
    let dropped = with_pool_mut(app, |data| {
        let (kept, dropped): (Vec<PoolEntry>, Vec<PoolEntry>) = std::mem::take(&mut data.entries)
            .into_iter()
            .partition(|entry| Path::new(&entry.path).exists());
        data.entries = kept;
        dropped
    })?;
    for entry in dropped {
        // Git refuses to delete the branch of a registered worktree, so prune first.
        let _ = git::prune_worktrees(&entry.project_path);
        if let Err(e) = git::delete_branch(&entry.project_path, &entry.branch) {
            log::warn!(
                "Worktree pool: failed to delete branch {}: {e}",
                entry.branch
            );
        }
    }
    Ok(())
}

/// At start, finish what a crash interrupted: remove busy entries and their checkouts.
/// An entry whose folder is already a registered worktree was claimed and saved; it is
/// only forgotten. Call it before the first reconcile, when no claim or fill can run.
pub fn cleanup_stale_entries(app: &AppHandle) {
    let stale: Vec<PoolEntry> = match read_pool(app) {
        Ok(data) => data.entries.into_iter().filter(|e| e.busy).collect(),
        Err(e) => {
            log::warn!("Worktree pool: {e}");
            return;
        }
    };
    if stale.is_empty() {
        return;
    }
    let registered: HashSet<String> = match load_projects_data(app) {
        Ok(data) => data.worktrees.into_iter().map(|w| w.path).collect(),
        Err(e) => {
            // Without the list we cannot tell a claimed worktree from an orphan.
            log::warn!("Worktree pool: stale cleanup skipped: {e}");
            return;
        }
    };
    for entry in stale {
        if registered.contains(&entry.path) {
            forget(app, &entry);
        } else {
            retire(app, &entry, false);
        }
    }
}

/// Paths of the pool worktrees of one project.
pub fn pool_paths_for_project(app: &AppHandle, project_id: &str) -> Vec<String> {
    match read_pool(app) {
        Ok(data) => data
            .entries
            .into_iter()
            .filter(|entry| entry.project_id == project_id)
            .map(|entry| entry.path)
            .collect(),
        Err(e) => {
            log::warn!("Worktree pool: {e}");
            Vec::new()
        }
    }
}

/// Marks a reconcile as running for a project; clears the mark when done or on drop.
struct FillGuard {
    project_id: String,
    released: bool,
}

impl FillGuard {
    /// `None` when a reconcile already runs; that one is told to run again.
    fn acquire(project_id: &str) -> Option<Self> {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = filling.get_mut(project_id) {
            state.dirty = true;
            return None;
        }
        filling.insert(project_id.to_string(), FillState::default());
        Some(Self {
            project_id: project_id.to_string(),
            released: false,
        })
    }

    fn set_filling(&self, count: u32) {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = filling.get_mut(&self.project_id) {
            state.count = count;
        }
    }

    /// A reconcile was asked for while this one ran: its settings may be out of date.
    fn is_dirty(&self) -> bool {
        let filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        filling.get(&self.project_id).is_some_and(|s| s.dirty)
    }

    /// `true`: a request came in during the run, so run again. `false`: the mark is
    /// cleared. One lock covers both, so a request cannot slip in between.
    fn finish_or_rerun(&mut self) -> bool {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        match filling.get_mut(&self.project_id) {
            Some(state) if state.dirty => {
                *state = FillState::default();
                true
            }
            _ => {
                filling.remove(&self.project_id);
                self.released = true;
                false
            }
        }
    }
}

impl Drop for FillGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        filling.remove(&self.project_id);
    }
}

fn filling_count(project_id: &str) -> u32 {
    let filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
    filling.get(project_id).map_or(0, |s| s.count)
}

/// Reconcile one project's pool in a background thread.
pub fn schedule_reconcile(app: &AppHandle, project_id: &str) {
    let app = app.clone();
    let project_id = project_id.to_string();
    std::thread::spawn(move || reconcile_project(&app, &project_id));
}

/// Reconcile every project now, then every 10 minutes.
pub fn start_pool_maintainer(app: AppHandle) {
    std::thread::spawn(move || {
        cleanup_stale_entries(&app);
        loop {
            reconcile_all(&app);
            std::thread::sleep(MAINTAINER_INTERVAL);
        }
    });
}

fn reconcile_all(app: &AppHandle) {
    let mut project_ids: Vec<String> = match load_projects_data(app) {
        Ok(data) => data
            .projects
            .iter()
            .filter(|p| !p.is_folder)
            .map(|p| p.id.clone())
            .collect(),
        Err(e) => {
            log::warn!("Worktree pool: failed to load projects: {e}");
            return;
        }
    };
    // Entries of removed projects are cleaned up by their own reconcile.
    if let Ok(pool) = read_pool(app) {
        for entry in pool.entries {
            if !project_ids.contains(&entry.project_id) {
                project_ids.push(entry.project_id);
            }
        }
    }
    for project_id in project_ids {
        reconcile_project(app, &project_id);
    }
}

fn reconcile_project(app: &AppHandle, project_id: &str) {
    let Some(mut guard) = FillGuard::acquire(project_id) else {
        return;
    };
    loop {
        if let Err(e) = reconcile_inner(app, project_id, &guard) {
            log::warn!("Worktree pool: reconcile of project {project_id} failed: {e}");
        }
        if !guard.finish_or_rerun() {
            break;
        }
    }
}

/// Mark the oldest `count` idle entries of a project busy (all when `None`) and return
/// them. The caller ends each one with `forget` (done), `release` (put back) or
/// `retire` (remove the checkout).
fn take_entries(
    app: &AppHandle,
    project_id: &str,
    count: Option<usize>,
    matches: &dyn Fn(&PoolEntry) -> bool,
) -> Result<Vec<PoolEntry>, String> {
    with_pool_mut(app, |data| {
        let mut idle: Vec<&mut PoolEntry> = data
            .entries
            .iter_mut()
            .filter(|e| e.project_id == project_id && !e.busy && matches(e))
            .collect();
        idle.sort_by_key(|e| e.created_at);
        if let Some(count) = count {
            idle.truncate(count);
        }
        idle.into_iter()
            .map(|e| {
                e.busy = true;
                e.clone()
            })
            .collect()
    })
}

/// An entry is usable when its folder is directly in the project's worktrees dir.
fn in_worktrees_dir(entry: &PoolEntry, dir: &Path) -> bool {
    Path::new(&entry.path).parent() == Some(dir)
}

/// Creates without a PR context use the pool. PR worktrees need `gh pr checkout`.
pub fn use_pool_for(pr_context_present: bool) -> bool {
    !pr_context_present
}

/// Take the oldest ready worktree of `project`. `None` when its pool is off or empty.
pub fn take(app: &AppHandle, project: &Project) -> Option<PoolEntry> {
    let enabled = project
        .worktree_pool_settings
        .as_ref()
        .is_some_and(|s| s.enabled);
    if !enabled {
        return None;
    }
    let dir = get_project_worktrees_dir(&project.name, project.worktrees_dir.as_deref()).ok()?;
    loop {
        let entry = match take_entries(app, &project.id, Some(1), &|_| true) {
            Ok(mut entries) => entries.pop()?,
            Err(e) => {
                log::warn!("Worktree pool: take failed for {}: {e}", project.id);
                return None;
            }
        };
        if in_worktrees_dir(&entry, &dir) {
            return Some(entry);
        }
        // Made for an earlier worktrees dir. Each pass marks one more entry busy.
        discard(app, entry);
    }
}

/// The worktree of a taken entry is registered: the pool does not track it any more.
pub fn forget(app: &AppHandle, entry: &PoolEntry) {
    if let Err(e) = with_pool_mut(app, |data| data.entries.retain(|e| e.id != entry.id)) {
        log::warn!("Worktree pool: failed to forget {}: {e}", entry.path);
    }
}

fn put_back(app: &AppHandle, entry: PoolEntry) -> Result<(), String> {
    with_pool_mut(app, |data| {
        match data.entries.iter().position(|e| e.id == entry.id) {
            Some(i) => data.entries[i].busy = false,
            None => data.entries.push(PoolEntry {
                busy: false,
                ..entry
            }),
        }
    })
}

/// Put a taken, unchanged worktree back into the pool.
pub fn release(app: &AppHandle, entry: PoolEntry) {
    let project_id = entry.project_id.clone();
    if let Err(e) = put_back(app, entry) {
        log::warn!("Worktree pool: release failed for {project_id}: {e}");
    }
    schedule_reconcile(app, &project_id);
}

/// Remove a taken worktree that could not be prepared, then refill.
pub fn discard_now(app: &AppHandle, entry: PoolEntry) {
    retire(app, &entry, true);
    schedule_reconcile(app, &entry.project_id);
}

/// `discard_now` in a background thread.
pub fn discard(app: &AppHandle, entry: PoolEntry) {
    let app = app.clone();
    std::thread::spawn(move || discard_now(&app, entry));
}

/// Reset a taken worktree to `start_point` and rename its branch to `name`.
/// Returns the final branch name (`rename_branch` makes it unique when taken).
pub fn prepare_taken(entry: &PoolEntry, name: &str, start_point: &str) -> Result<String, String> {
    git::reset_hard(&entry.path, start_point)?;
    if name == entry.branch {
        return Ok(entry.branch.clone());
    }
    git::rename_branch(&entry.path, name)
}

/// Remove the checkout and branch of an entry, then drop it from the file.
fn retire(app: &AppHandle, entry: &PoolEntry, run_teardown: bool) {
    remove_entry_checkout(entry, run_teardown);
    forget(app, entry);
}

fn remove_entry_checkout(entry: &PoolEntry, run_teardown: bool) {
    if run_teardown && Path::new(&entry.path).join(".git").exists() {
        let teardown = git::resolve_jean_config(&entry.path, Some(&entry.project_path))
            .and_then(|config| config.scripts.teardown);
        if let Some(script) = teardown {
            if let Err(e) =
                git::run_teardown_script(&entry.path, &entry.project_path, &entry.branch, &script)
            {
                log::warn!("Worktree pool: teardown failed for {}: {e}", entry.path);
            }
        }
    }
    if let Err(e) = git::remove_worktree(&entry.project_path, &entry.path) {
        log::warn!("Worktree pool: failed to remove {}: {e}", entry.path);
    }
    if let Err(e) = git::delete_branch(&entry.project_path, &entry.branch) {
        log::warn!(
            "Worktree pool: failed to delete branch {}: {e}",
            entry.branch
        );
    }
}

fn reconcile_inner(app: &AppHandle, project_id: &str, guard: &FillGuard) -> Result<(), String> {
    drop_missing_entries(app)?;

    let data = load_projects_data(app)?;
    let Some(project) = data
        .find_project(project_id)
        .filter(|p| !p.is_folder)
        .cloned()
    else {
        // Project was removed: its checkouts go too, without teardown.
        let entries: Vec<PoolEntry> = read_pool(app)?
            .entries
            .into_iter()
            .filter(|e| e.project_id == project_id)
            .collect();
        for entry in entries {
            retire(app, &entry, false);
        }
        return Ok(());
    };

    let settings = project
        .worktree_pool_settings
        .clone()
        .unwrap_or_default()
        .normalize();
    let count_idle = || -> Result<u32, String> {
        Ok(read_pool(app)?
            .entries
            .iter()
            .filter(|e| e.project_id == project_id && !e.busy)
            .count() as u32)
    };

    // Entries made for an earlier worktrees dir are replaced. The dir is only looked up
    // when there is something to check: looking it up creates the folder.
    if count_idle()? > 0 {
        let dir = get_project_worktrees_dir(&project.name, project.worktrees_dir.as_deref())?;
        for entry in take_entries(app, project_id, None, &|e| !in_worktrees_dir(e, &dir))? {
            retire(app, &entry, true);
        }
    }

    let idle = count_idle()?;
    let trim = trim_needed(idle, &settings);
    if trim > 0 {
        // Marked busy first, so nobody takes an entry that is being deleted.
        for entry in take_entries(app, project_id, Some(trim as usize), &|_| true)? {
            retire(app, &entry, true);
        }
        return Ok(());
    }

    let refill = refill_needed(idle, 0, &settings);
    if refill == 0 {
        return Ok(());
    }
    let auto_pull = crate::load_preferences_sync(app)
        .map(|prefs| prefs.auto_pull_base_branch)
        .unwrap_or(false);
    for done in 0..refill {
        // A new request came in: the settings may have changed. The caller runs again
        // with fresh settings.
        if guard.is_dirty() {
            break;
        }
        guard.set_filling(refill - done);
        if let Err(e) = create_entry(app, &project, auto_pull) {
            log::warn!("Worktree pool: failed to create worktree for {project_id}: {e}");
            break;
        }
    }
    Ok(())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Create one checkout from the project's default branch, run its setup script, and
/// add it to the pool as idle.
fn create_entry(app: &AppHandle, project: &Project, auto_pull: bool) -> Result<(), String> {
    let base = git::get_valid_base_branch(&project.path, &project.default_branch)?;
    let worktrees_dir = get_project_worktrees_dir(&project.name, project.worktrees_dir.as_deref())?;

    let data = load_projects_data(app)?;
    let pool_names: HashSet<String> = read_pool(app)?
        .entries
        .into_iter()
        .filter(|e| e.project_id == project.id)
        .map(|e| e.name)
        .collect();
    let name = generate_unique_workspace_name(|n| {
        data.worktree_name_exists(&project.id, n)
            || pool_names.contains(n)
            || git::branch_exists(&project.path, n)
            || worktrees_dir.join(sanitize_folder_name(n)).exists()
    });
    let path = worktrees_dir.join(sanitize_folder_name(&name));
    let path = path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    let start_point = resolve_start_point(&project.path, &base, None, auto_pull);
    git::create_worktree(&project.path, &path, &name, &start_point)?;

    // Tracked as busy from now on, so a crash during setup leaves a trace that
    // `cleanup_stale_entries` removes at the next start.
    let mut entry = PoolEntry {
        id: Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        project_path: project.path.clone(),
        name: name.clone(),
        path,
        branch: name,
        base_branch: base,
        created_at: now(),
        setup_script: None,
        setup_output: None,
        setup_success: None,
        busy: true,
    };
    if let Err(e) = with_pool_mut(app, |data| data.entries.push(entry.clone())) {
        remove_entry_checkout(&entry, false);
        return Err(e);
    }

    entry.setup_script = git::resolve_jean_config(&entry.path, Some(&project.path))
        .and_then(|config| config.scripts.setup);
    if let Some(script) = entry.setup_script.as_deref() {
        match git::run_setup_script(&entry.path, &project.path, &entry.name, script) {
            Ok(output) => {
                entry.setup_output = Some(output);
                entry.setup_success = Some(true);
            }
            Err(e) => {
                log::warn!("Worktree pool: setup script failed for {}: {e}", entry.path);
                entry.setup_output = Some(e);
                entry.setup_success = Some(false);
            }
        }
    }

    entry.busy = false;
    with_pool_mut(app, |data| {
        if let Some(slot) = data.entries.iter_mut().find(|e| e.id == entry.id) {
            *slot = entry.clone();
        }
    })
}

pub async fn get_worktree_pool_status(
    app: AppHandle,
    project_id: String,
) -> Result<WorktreePoolStatus, String> {
    let idle = read_pool(&app)?
        .entries
        .iter()
        .filter(|e| e.project_id == project_id && !e.busy)
        .count() as u32;
    Ok(WorktreePoolStatus {
        idle,
        filling: filling_count(&project_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(enabled: bool, min_idle: u32, max_idle: u32) -> ProjectWorktreePoolSettings {
        ProjectWorktreePoolSettings {
            enabled,
            min_idle,
            max_idle,
        }
    }

    fn test_app(root: &Path) -> AppHandle {
        AppHandle::new(root.join("data"), root.join("resources")).expect("app")
    }

    fn entry(project_id: &str, path: &str) -> PoolEntry {
        PoolEntry {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            project_path: "/repo".to_string(),
            name: "swift-falcon".to_string(),
            path: path.to_string(),
            branch: "swift-falcon".to_string(),
            base_branch: "main".to_string(),
            created_at: 1,
            setup_script: None,
            setup_output: None,
            setup_success: None,
            busy: false,
        }
    }

    #[test]
    fn worktree_pool_refill_needed() {
        assert_eq!(refill_needed(0, 0, &settings(true, 1, 2)), 2);
        assert_eq!(refill_needed(1, 0, &settings(true, 1, 2)), 0);
        assert_eq!(refill_needed(0, 1, &settings(true, 1, 3)), 2);
        assert_eq!(refill_needed(0, 0, &settings(false, 1, 2)), 0);
    }

    #[test]
    fn worktree_pool_trim_needed() {
        assert_eq!(trim_needed(3, &settings(true, 1, 2)), 1);
        assert_eq!(trim_needed(2, &settings(false, 1, 2)), 2);
        assert_eq!(trim_needed(1, &settings(true, 1, 2)), 0);
    }

    #[test]
    fn worktree_pool_normalize() {
        assert_eq!(settings(true, 0, 0).normalize(), settings(true, 1, 1));
        assert_eq!(settings(true, 5, 2).normalize(), settings(true, 5, 5));
        assert_eq!(settings(true, 1, 50).normalize().max_idle, 10);
    }

    #[test]
    fn drop_missing_entries_removes_entry_with_missing_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let missing = temp.path().join("gone");
        with_pool_mut(&app, |data| {
            data.entries
                .push(entry("p1", missing.to_str().expect("path")));
        })
        .expect("write pool");

        drop_missing_entries(&app).expect("drop");

        assert!(read_pool(&app).expect("read").entries.is_empty());
    }

    #[test]
    fn pool_paths_for_project_returns_entry_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        with_pool_mut(&app, |data| {
            data.entries.push(entry("p1", "/wt/a"));
            data.entries.push(entry("p2", "/wt/b"));
            data.entries.push(entry("p1", "/wt/c"));
        })
        .expect("write pool");

        assert_eq!(
            pool_paths_for_project(&app, "p1"),
            vec!["/wt/a".to_string(), "/wt/c".to_string()]
        );
        assert!(pool_paths_for_project(&app, "missing").is_empty());
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let output = crate::platform::silent_command("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Project "demo" whose worktrees dir is `<base>`; its folder is `<base>/demo`.
    fn project(pool: Option<bool>, base: &Path) -> Project {
        let mut value = serde_json::json!({
            "id": "p1",
            "name": "demo",
            "path": "/repo",
            "default_branch": "main",
            "added_at": 1,
            "worktrees_dir": base.to_str().expect("path")
        });
        if let Some(enabled) = pool {
            value["worktree_pool_settings"] =
                serde_json::json!({ "enabled": enabled, "min_idle": 1, "max_idle": 2 });
        }
        serde_json::from_value(value).expect("project")
    }

    fn entry_at(project_id: &str, path: &str, created_at: u64) -> PoolEntry {
        PoolEntry {
            created_at,
            ..entry(project_id, path)
        }
    }

    fn path_in(base: &Path, name: &str) -> String {
        base.join("demo")
            .join(name)
            .to_str()
            .expect("path")
            .to_string()
    }

    #[test]
    fn take_marks_entry_busy_and_second_take_gets_next() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let base = temp.path().join("wt");
        let newer = entry_at("p1", &path_in(&base, "newer"), 20);
        let older = entry_at("p1", &path_in(&base, "older"), 10);
        with_pool_mut(&app, |data| {
            data.entries.push(newer.clone());
            data.entries.push(entry_at("p2", "/wt/other", 1));
            data.entries.push(older.clone());
        })
        .expect("write pool");
        let project = project(Some(true), &base);

        assert_eq!(take(&app, &project).map(|e| e.id), Some(older.id));
        assert_eq!(take(&app, &project).map(|e| e.id), Some(newer.id));
        assert_eq!(take(&app, &project), None);
        // Taken entries stay in the file as busy until the new worktree is saved.
        let pool = read_pool(&app).expect("read");
        assert_eq!(pool.entries.iter().filter(|e| e.busy).count(), 2);
        assert!(pool.entries.iter().any(|e| e.project_id == "p2" && !e.busy));
    }

    #[test]
    fn take_returns_none_when_pool_disabled() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let base = temp.path().join("wt");
        with_pool_mut(&app, |data| {
            data.entries.push(entry("p1", &path_in(&base, "a")))
        })
        .expect("write pool");

        assert_eq!(take(&app, &project(Some(false), &base)), None);
        assert_eq!(take(&app, &project(None, &base)), None);
        assert!(read_pool(&app)
            .expect("read")
            .entries
            .iter()
            .all(|e| !e.busy));
    }

    #[test]
    fn release_makes_busy_entry_idle_again() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let base = temp.path().join("wt");
        let original = entry("p1", &path_in(&base, "a"));
        with_pool_mut(&app, |data| data.entries.push(original.clone())).expect("write pool");
        let taken = take(&app, &project(Some(true), &base)).expect("taken");
        assert!(taken.busy);

        // `release` also schedules a reconcile; test only the put-back part.
        put_back(&app, taken).expect("put back");

        assert_eq!(read_pool(&app).expect("read").entries, vec![original]);
    }

    #[test]
    fn forget_removes_only_that_entry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let keep = entry("p1", "/wt/keep");
        let gone = entry("p1", "/wt/gone");
        with_pool_mut(&app, |data| {
            data.entries.push(keep.clone());
            data.entries.push(gone.clone());
        })
        .expect("write pool");

        forget(&app, &gone);

        assert_eq!(read_pool(&app).expect("read").entries, vec![keep]);
    }

    #[test]
    fn entry_outside_worktrees_dir_is_not_usable() {
        let dir = Path::new("/wt/demo");
        assert!(in_worktrees_dir(&entry("p1", "/wt/demo/a"), dir));
        assert!(!in_worktrees_dir(&entry("p1", "/old/demo/a"), dir));
        assert!(!in_worktrees_dir(&entry("p1", "/wt/demo/a/b"), dir));
    }

    #[test]
    fn request_during_reconcile_makes_it_run_again() {
        let id = "fill-guard-test";
        let mut guard = FillGuard::acquire(id).expect("first acquire");
        assert!(!guard.is_dirty());

        assert!(FillGuard::acquire(id).is_none());
        assert!(guard.is_dirty());

        assert!(guard.finish_or_rerun());
        assert!(!guard.is_dirty());
        assert!(!guard.finish_or_rerun());

        // The mark is cleared: a new reconcile can start.
        assert!(FillGuard::acquire(id).is_some());
    }

    #[test]
    fn cleanup_stale_entries_removes_busy_entries_only() {
        let temp = tempfile::tempdir().expect("tempdir");
        let app = test_app(temp.path());
        let idle = entry("p1", "/wt/idle");
        let busy = PoolEntry {
            busy: true,
            ..entry("p1", "/wt/busy")
        };
        with_pool_mut(&app, |data| {
            data.entries.push(idle.clone());
            data.entries.push(busy);
        })
        .expect("write pool");

        cleanup_stale_entries(&app);

        assert_eq!(read_pool(&app).expect("read").entries, vec![idle]);
    }

    #[test]
    fn worktree_pool_use_pool_for() {
        assert!(!use_pool_for(true));
        assert!(use_pool_for(false));
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let output = crate::platform::silent_command("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Repo with two commits and a pool-like worktree `calm-otter` at commit 1.
    fn repo_with_pooled_worktree(root: &Path) -> (PoolEntry, String, PathBuf) {
        let repo = root.join("repo");
        std::fs::create_dir(&repo).expect("repo dir");
        run_git(&repo, &["init", "--initial-branch", "main"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one").expect("write");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "one"]);
        let commit1 = git_out(&repo, &["rev-parse", "HEAD"]);
        std::fs::write(repo.join("a.txt"), "two").expect("write");
        run_git(&repo, &["commit", "-am", "two"]);
        let commit2 = git_out(&repo, &["rev-parse", "HEAD"]);
        let wt = root.join("calm-otter");
        let wt_str = wt.to_str().expect("path").to_string();
        run_git(
            &repo,
            &["worktree", "add", "-b", "calm-otter", &wt_str, &commit1],
        );
        let entry = PoolEntry {
            project_path: repo.to_str().expect("path").to_string(),
            name: "calm-otter".to_string(),
            branch: "calm-otter".to_string(),
            ..entry("p1", &wt_str)
        };
        (entry, commit2, wt)
    }

    #[test]
    fn prepare_taken_resets_to_start_point_and_renames() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (entry, commit2, wt) = repo_with_pooled_worktree(temp.path());

        assert_eq!(
            prepare_taken(&entry, "my-feature", &commit2),
            Ok("my-feature".to_string())
        );
        assert_eq!(git_out(&wt, &["rev-parse", "HEAD"]), commit2);
        assert_eq!(git_out(&wt, &["branch", "--show-current"]), "my-feature");
    }

    #[test]
    fn prepare_taken_keeps_branch_when_name_matches() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (entry, commit2, wt) = repo_with_pooled_worktree(temp.path());

        assert_eq!(
            prepare_taken(&entry, "calm-otter", &commit2),
            Ok("calm-otter".to_string())
        );
        assert_eq!(git_out(&wt, &["branch", "--show-current"]), "calm-otter");
        assert_eq!(git_out(&wt, &["rev-parse", "HEAD"]), commit2);
    }

    #[test]
    fn worktree_pool_reconcile_fills_and_trims() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        let app = test_app(root);
        let repo = root.join("repo");
        std::fs::create_dir(&repo).expect("repo dir");
        run_git(&repo, &["init", "--initial-branch", "main"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.txt"), "one").expect("write");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "init"]);
        let worktrees = root.join("worktrees");

        let write_projects = |enabled: bool| {
            let data = serde_json::json!({
                "projects": [{
                    "id": "p1",
                    "name": "demo",
                    "path": repo.to_str().unwrap(),
                    "default_branch": "main",
                    "added_at": 1,
                    "worktrees_dir": worktrees.to_str().unwrap(),
                    "worktree_pool_settings": { "enabled": enabled, "min_idle": 1, "max_idle": 2 }
                }],
                "worktrees": []
            });
            let data = serde_json::from_value(data).expect("projects");
            super::super::storage::save_projects_data(&app, &data).expect("save projects");
        };

        write_projects(true);
        reconcile_project(&app, "p1");
        let paths = pool_paths_for_project(&app, "p1");
        assert_eq!(paths.len(), 2);
        for path in &paths {
            assert!(
                Path::new(path).join(".git").exists(),
                "{path} not a checkout"
            );
        }

        write_projects(false);
        reconcile_project(&app, "p1");
        assert!(pool_paths_for_project(&app, "p1").is_empty());
        for path in &paths {
            assert!(!Path::new(path).exists(), "{path} not removed");
        }
    }
}
