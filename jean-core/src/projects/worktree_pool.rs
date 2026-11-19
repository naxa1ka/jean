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

/// Project id -> worktrees in creation. A key is present while a reconcile runs.
static FILLING: Lazy<Mutex<HashMap<String, u32>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// One ready worktree that no session uses yet.
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

/// Drop entries whose folder no longer exists (deleted outside Jean).
pub fn drop_missing_entries(app: &AppHandle) -> Result<(), String> {
    with_pool_mut(app, |data| {
        data.entries.retain(|entry| Path::new(&entry.path).exists());
    })
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

/// Marks a reconcile as running for a project; clears the mark on drop.
struct FillGuard {
    project_id: String,
}

impl FillGuard {
    fn acquire(project_id: &str) -> Option<Self> {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        if filling.contains_key(project_id) {
            return None;
        }
        filling.insert(project_id.to_string(), 0);
        Some(Self {
            project_id: project_id.to_string(),
        })
    }

    fn set_filling(&self, count: u32) {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        filling.insert(self.project_id.clone(), count);
    }
}

impl Drop for FillGuard {
    fn drop(&mut self) {
        let mut filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
        filling.remove(&self.project_id);
    }
}

fn filling_count(project_id: &str) -> u32 {
    let filling = FILLING.lock().unwrap_or_else(|e| e.into_inner());
    filling.get(project_id).copied().unwrap_or(0)
}

/// Reconcile one project's pool in a background thread.
pub fn schedule_reconcile(app: &AppHandle, project_id: &str) {
    let app = app.clone();
    let project_id = project_id.to_string();
    std::thread::spawn(move || reconcile_project(&app, &project_id));
}

/// Reconcile every project now, then every 10 minutes.
pub fn start_pool_maintainer(app: AppHandle) {
    std::thread::spawn(move || loop {
        reconcile_all(&app);
        std::thread::sleep(MAINTAINER_INTERVAL);
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
    let Some(guard) = FillGuard::acquire(project_id) else {
        return;
    };
    if let Err(e) = reconcile_inner(app, project_id, &guard) {
        log::warn!("Worktree pool: reconcile of project {project_id} failed: {e}");
    }
}

fn take_entries(
    app: &AppHandle,
    project_id: &str,
    count: Option<usize>,
) -> Result<Vec<PoolEntry>, String> {
    with_pool_mut(app, |data| {
        let mut mine: Vec<PoolEntry> = data
            .entries
            .iter()
            .filter(|e| e.project_id == project_id)
            .cloned()
            .collect();
        mine.sort_by_key(|e| e.created_at);
        if let Some(count) = count {
            mine.truncate(count);
        }
        let ids: HashSet<&str> = mine.iter().map(|e| e.id.as_str()).collect();
        data.entries.retain(|e| !ids.contains(e.id.as_str()));
        mine
    })
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
        log::warn!("Worktree pool: failed to delete branch {}: {e}", entry.branch);
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
        for entry in take_entries(app, project_id, None)? {
            remove_entry_checkout(&entry, false);
        }
        return Ok(());
    };

    let settings = project
        .worktree_pool_settings
        .clone()
        .unwrap_or_default()
        .normalize();
    let idle = read_pool(app)?
        .entries
        .iter()
        .filter(|e| e.project_id == project_id)
        .count() as u32;

    let trim = trim_needed(idle, &settings);
    if trim > 0 {
        // Remove from the file first, so nobody takes an entry that is being deleted.
        for entry in take_entries(app, project_id, Some(trim as usize))? {
            remove_entry_checkout(&entry, true);
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
        guard.set_filling(refill - done);
        match create_entry(app, &project, auto_pull) {
            Ok(entry) => {
                with_pool_mut(app, |pool| pool.entries.push(entry))?;
            }
            Err(e) => {
                log::warn!("Worktree pool: failed to create worktree for {project_id}: {e}");
                break;
            }
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

/// Create one checkout from the project's default branch and run its setup script.
fn create_entry(app: &AppHandle, project: &Project, auto_pull: bool) -> Result<PoolEntry, String> {
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

    let setup_script = git::resolve_jean_config(&path, Some(&project.path))
        .and_then(|config| config.scripts.setup);
    let (setup_output, setup_success) = match setup_script.as_deref() {
        Some(script) => match git::run_setup_script(&path, &project.path, &name, script) {
            Ok(output) => (Some(output), Some(true)),
            Err(e) => {
                log::warn!("Worktree pool: setup script failed for {path}: {e}");
                (Some(e), Some(false))
            }
        },
        None => (None, None),
    };

    Ok(PoolEntry {
        id: Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        project_path: project.path.clone(),
        name: name.clone(),
        path,
        branch: name,
        base_branch: base,
        created_at: now(),
        setup_script,
        setup_output,
        setup_success,
    })
}

pub async fn get_worktree_pool_status(
    app: AppHandle,
    project_id: String,
) -> Result<WorktreePoolStatus, String> {
    let idle = read_pool(&app)?
        .entries
        .iter()
        .filter(|e| e.project_id == project_id)
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
            assert!(Path::new(path).join(".git").exists(), "{path} not a checkout");
        }

        write_projects(false);
        reconcile_project(&app, "p1");
        assert!(pool_paths_for_project(&app, "p1").is_empty());
        for path in &paths {
            assert!(!Path::new(path).exists(), "{path} not removed");
        }
    }
}
