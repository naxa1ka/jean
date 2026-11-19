//! Link a PR that the agent created itself (e.g. `gh pr create` in Bash).
//! After each run, check the worktree branch for an open PR/MR when the
//! worktree has no link yet. Backend-owned, so it works with no client open.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use tauri::AppHandle;

use crate::http_server::EmitExt;
use crate::projects::storage::load_projects_data;
use crate::projects::types::SessionType;

/// Worktrees with a check in progress, so parallel run ends run `gh` once.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn start_pr_autolink_listener(app: &AppHandle) {
    let listener_app = app.clone();
    app.listen("chat:done", move |event| {
        let Some(worktree_id) = worktree_id_from_payload(event.payload()) else {
            return;
        };
        if !IN_FLIGHT.lock().unwrap().insert(worktree_id.clone()) {
            return;
        }
        let app = listener_app.clone();
        std::thread::spawn(move || {
            autolink_after_run(&app, &worktree_id);
            IN_FLIGHT.lock().unwrap().remove(&worktree_id);
        });
    });
}

fn worktree_id_from_payload(payload: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let id = value
        .get("worktree_id")
        .or_else(|| value.get("worktreeId"))?
        .as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

fn needs_pr_link(session_type: &SessionType, pr_number: Option<u32>, pr_url: Option<&str>) -> bool {
    *session_type != SessionType::Base && !(pr_number.is_some() && pr_url.is_some())
}

fn autolink_after_run(app: &AppHandle, worktree_id: &str) {
    let Ok(data) = load_projects_data(app) else {
        return;
    };
    let Some(path) = data
        .worktrees
        .iter()
        .find(|w| w.id == worktree_id)
        .filter(|w| needs_pr_link(&w.session_type, w.pr_number, w.pr_url.as_deref()))
        .map(|w| w.path.clone())
    else {
        return;
    };

    match super::commands::detect_and_link_pr_for_worktree(app, worktree_id, &path) {
        Ok(Some(pr)) => {
            log::info!("Auto-linked PR #{} to worktree {worktree_id}", pr.pr_number);
            if let Err(e) = app.emit_all(
                "cache:invalidate",
                &serde_json::json!({ "keys": ["projects"] }),
            ) {
                log::error!("Failed to emit cache:invalidate: {e}");
            }
            crate::background_tasks::refresh_pr_status_after_push(
                app,
                worktree_id.to_string(),
                path,
                pr.pr_number,
                pr.pr_url,
            );
        }
        Ok(None) => {}
        // No forge remote, gh not authenticated, offline: not an error for the run.
        Err(e) => log::debug!("PR auto-link skipped for {worktree_id}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_worktree_id_from_done_payload() {
        let payload = r#"{"session_id":"s1","worktree_id":"w1","waiting_for_plan":false}"#;
        assert_eq!(worktree_id_from_payload(payload).as_deref(), Some("w1"));
        assert_eq!(worktree_id_from_payload(r#"{"session_id":"s1"}"#), None);
        assert_eq!(worktree_id_from_payload(r#"{"worktree_id":""}"#), None);
        assert_eq!(worktree_id_from_payload("not json"), None);
    }

    #[test]
    fn only_unlinked_non_base_worktrees_need_a_link() {
        let wt = SessionType::Worktree;
        assert!(needs_pr_link(&wt, None, None));
        assert!(needs_pr_link(&wt, Some(7), None)); // number without URL: detection fills URL
        assert!(!needs_pr_link(
            &wt,
            Some(7),
            Some("https://github.com/o/r/pull/7")
        ));
        assert!(!needs_pr_link(&SessionType::Base, None, None));
    }
}
