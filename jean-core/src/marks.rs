//! Rename and remove a mark on every worktree and session of this server.
//!
//! The project pins (`pinned_labels` in ui-state.json) belong to each client,
//! so these commands never write them. The client renames its own pins.

use serde::Serialize;
use tauri::AppHandle;

use crate::chat::types::{validate_mark_definitions, LabelData};

/// How many items use a mark (count) or were changed (rename/remove).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkUsage {
    pub worktrees: usize,
    pub sessions: usize,
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Rename `old` to `new` (case-insensitive match). The mark keeps its color,
/// pin, and `added_at`. When the item already has `new`, the two marks become
/// one: the first one stays, and it is pinned when either was pinned.
/// Returns true when the list changed.
pub fn rename_in_labels(labels: &mut Vec<LabelData>, old: &str, new: &str) -> bool {
    let mut changed = false;
    for label in labels.iter_mut() {
        if same_name(&label.name, old) && label.name != new {
            label.name = new.to_string();
            changed = true;
        }
    }
    if !changed {
        return false;
    }
    let mut merged: Vec<LabelData> = Vec::with_capacity(labels.len());
    for label in labels.drain(..) {
        match merged
            .iter_mut()
            .find(|kept| same_name(&kept.name, &label.name))
        {
            Some(kept) => kept.pinned |= label.pinned,
            None => merged.push(label),
        }
    }
    *labels = merged;
    true
}

/// Remove every mark named `name` (case-insensitive). Returns true when the list changed.
pub fn remove_from_labels(labels: &mut Vec<LabelData>, name: &str) -> bool {
    let before = labels.len();
    labels.retain(|label| !same_name(&label.name, name));
    labels.len() != before
}

/// Run `apply` on the marks of every worktree (one projects.json write) and every
/// session (only changed sessions are written). The result counts the changed items.
fn apply_to_all_marks(
    app: &AppHandle,
    apply: impl Fn(&mut Vec<LabelData>) -> bool,
) -> Result<MarkUsage, String> {
    let worktrees = crate::projects::storage::with_projects_data_mut(app, |data| {
        let mut changed = 0;
        for worktree in &mut data.worktrees {
            if apply(&mut worktree.labels) {
                worktree.label = None;
                changed += 1;
            }
        }
        Ok(changed)
    })?;

    let mut sessions = 0;
    for session_id in crate::chat::storage::list_all_session_ids(app)? {
        // Check a copy first, so sessions without the mark are not written.
        let mut labels = match crate::chat::storage::load_metadata(app, &session_id) {
            Ok(Some(metadata)) => metadata.labels,
            Ok(None) => continue,
            Err(error) => {
                log::warn!("Mark update skips session {session_id}: {error}");
                continue;
            }
        };
        if !apply(&mut labels) {
            continue;
        }
        match crate::chat::storage::with_existing_metadata_mut(app, &session_id, |metadata| {
            apply(&mut metadata.labels)
        }) {
            Ok(true) => sessions += 1,
            Ok(false) => {}
            Err(error) => log::warn!("Mark update skips session {session_id}: {error}"),
        }
    }

    Ok(MarkUsage {
        worktrees,
        sessions,
    })
}

/// Count the live worktrees and sessions that have the mark `name`.
/// Archived worktrees and closed sessions are not counted.
pub async fn count_mark_usage(app: AppHandle, name: String) -> Result<MarkUsage, String> {
    let has_mark = |labels: &[LabelData]| labels.iter().any(|l| same_name(&l.name, &name));
    let data = crate::projects::storage::load_projects_data(&app)?;
    let mut usage = MarkUsage::default();
    for worktree in data.worktrees.iter().filter(|w| w.archived_at.is_none()) {
        if has_mark(&worktree.labels) {
            usage.worktrees += 1;
        }
        let index = match crate::chat::storage::load_index(&app, &worktree.id) {
            Ok(index) => index,
            Err(error) => {
                log::warn!("Mark count skips worktree {}: {error}", worktree.id);
                continue;
            }
        };
        for entry in index.sessions.iter().filter(|s| s.archived_at.is_none()) {
            if let Ok(Some(metadata)) = crate::chat::storage::load_metadata(&app, &entry.id) {
                if metadata.archived_at.is_none() && has_mark(&metadata.labels) {
                    usage.sessions += 1;
                }
            }
        }
    }
    Ok(usage)
}

/// Rename a mark in the list, then on every worktree and session of this server.
pub async fn rename_mark(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<MarkUsage, String> {
    let new_name = new_name.trim().to_string();
    crate::mutate_preferences(&app, |prefs| {
        let list = &prefs.mark_definitions;
        let index = list
            .iter()
            .position(|d| same_name(&d.name, &old_name))
            .ok_or_else(|| format!("Mark '{old_name}' is not in the list"))?;
        if list
            .iter()
            .enumerate()
            .any(|(i, d)| i != index && same_name(&d.name, &new_name))
        {
            return Err(format!("A mark named '{new_name}' already exists"));
        }
        let mut next = list.clone();
        next[index].name = new_name.clone();
        prefs.mark_definitions = validate_mark_definitions(next)?;
        Ok(())
    })?;
    apply_to_all_marks(&app, |labels| {
        rename_in_labels(labels, &old_name, &new_name)
    })
}

/// Remove a mark from the list, then from every worktree and session of this server.
pub async fn remove_mark_everywhere(app: AppHandle, name: String) -> Result<MarkUsage, String> {
    crate::mutate_preferences(&app, |prefs| {
        prefs
            .mark_definitions
            .retain(|definition| !same_name(&definition.name, &name));
        Ok(())
    })?;
    apply_to_all_marks(&app, |labels| remove_from_labels(labels, &name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{Backend, Session, SessionIndexEntry, SessionMetadata};
    use crate::projects::types::{ProjectsData, Worktree};

    fn label(name: &str, pinned: bool, added_at: Option<u64>) -> LabelData {
        LabelData {
            name: name.to_string(),
            color: "#ff0000".to_string(),
            pinned,
            added_at,
        }
    }

    fn names(labels: &[LabelData]) -> Vec<&str> {
        labels.iter().map(|l| l.name.as_str()).collect()
    }

    fn test_app() -> (tempfile::TempDir, AppHandle) {
        let temp = tempfile::tempdir().unwrap();
        let app = AppHandle::new(temp.path().to_path_buf(), temp.path().to_path_buf()).unwrap();
        (temp, app)
    }

    fn worktree(temp: &tempfile::TempDir, id: &str, project_id: &str) -> Worktree {
        // The loader drops worktrees whose path does not exist.
        let path = temp.path().join(id);
        std::fs::create_dir_all(&path).unwrap();
        serde_json::from_value(serde_json::json!({
            "id": id, "project_id": project_id, "name": id,
            "path": path.to_string_lossy(), "branch": "main",
            "created_at": 1, "session_type": "worktree"
        }))
        .unwrap()
    }

    fn save_worktrees(app: &AppHandle, worktrees: Vec<Worktree>) {
        crate::projects::storage::save_projects_data(
            app,
            &ProjectsData {
                projects: vec![],
                worktrees,
            },
        )
        .unwrap();
    }

    /// Save a session with `labels` and add it to the worktree index.
    fn save_session(
        app: &AppHandle,
        worktree_id: &str,
        labels: Vec<LabelData>,
        archived: bool,
    ) -> String {
        let mut session = Session::new("s".to_string(), 0, Backend::Claude);
        let mut metadata = SessionMetadata::new(
            session.id.clone(),
            worktree_id.to_string(),
            "s".to_string(),
            0,
        );
        metadata.labels = labels;
        if archived {
            session.archived_at = Some(1);
            metadata.archived_at = Some(1);
        }
        crate::chat::storage::save_metadata(app, &metadata).unwrap();
        crate::chat::storage::with_index_mut(app, worktree_id, |index| {
            index
                .sessions
                .push(SessionIndexEntry::from_session(&session));
            Ok(())
        })
        .unwrap();
        session.id
    }

    fn session_labels(app: &AppHandle, id: &str) -> Vec<LabelData> {
        crate::chat::storage::load_metadata(app, id)
            .unwrap()
            .unwrap()
            .labels
    }

    fn worktree_labels(app: &AppHandle, id: &str) -> Vec<LabelData> {
        crate::projects::storage::load_projects_data(app)
            .unwrap()
            .find_worktree(id)
            .unwrap()
            .labels
            .clone()
    }

    fn set_list(app: &AppHandle, list: &[&str]) {
        crate::mutate_preferences(app, |prefs| {
            prefs.mark_definitions = list
                .iter()
                .map(|name| crate::chat::types::MarkDefinition {
                    name: name.to_string(),
                    color: "#ff0000".to_string(),
                    icon: None,
                    tracked: false,
                })
                .collect();
            Ok(())
        })
        .unwrap();
    }

    fn list_names(app: &AppHandle) -> Vec<String> {
        crate::load_preferences_sync(app)
            .unwrap()
            .mark_definitions
            .into_iter()
            .map(|d| d.name)
            .collect()
    }

    #[test]
    fn mark_rename_in_labels_is_case_insensitive_and_keeps_fields() {
        let mut labels = vec![label("Bug", false, None), label("review", true, Some(7))];
        assert!(rename_in_labels(&mut labels, "REVIEW", "Review later"));
        assert_eq!(names(&labels), vec!["Bug", "Review later"]);
        assert_eq!(labels[1], label("Review later", true, Some(7)));
        assert!(!rename_in_labels(&mut labels, "missing", "Other"));
        assert!(!rename_in_labels(&mut labels, "bug", "Bug"));
        assert!(rename_in_labels(&mut labels, "bug", "BUG"));
        assert_eq!(names(&labels), vec!["BUG", "Review later"]);
    }

    #[test]
    fn mark_rename_in_labels_dedupes_into_the_existing_name() {
        let mut labels = vec![label("New", false, Some(1)), label("Old", true, Some(2))];
        assert!(rename_in_labels(&mut labels, "old", "new"));
        assert_eq!(labels, vec![label("New", true, Some(1))]);
    }

    #[test]
    fn mark_remove_from_labels_is_case_insensitive() {
        let mut labels = vec![label("Bug", false, None), label("QA", false, None)];
        assert!(remove_from_labels(&mut labels, "bug"));
        assert_eq!(names(&labels), vec!["QA"]);
        assert!(!remove_from_labels(&mut labels, "bug"));
    }

    #[tokio::test]
    async fn mark_rename_updates_worktrees_and_sessions_of_all_projects() {
        let (temp, app) = test_app();
        let mut wt_a = worktree(&temp, "wt-a", "project-a");
        wt_a.labels = vec![label("Bug", true, Some(5))];
        let mut wt_b = worktree(&temp, "wt-b", "project-b");
        wt_b.labels = vec![label("QA", false, None)];
        save_worktrees(&app, vec![wt_a, wt_b]);
        let s_a = save_session(&app, "wt-a", vec![label("bug", false, Some(9))], false);
        let s_b = save_session(&app, "wt-b", vec![label("BUG", false, None)], true);
        let s_other = save_session(&app, "wt-b", vec![label("QA", false, None)], false);
        set_list(&app, &["Bug", "QA"]);

        let usage = rename_mark(app.clone(), "bug".into(), " Defect ".into())
            .await
            .unwrap();

        assert_eq!(
            usage,
            MarkUsage {
                worktrees: 1,
                sessions: 2
            }
        );
        assert_eq!(list_names(&app), vec!["Defect", "QA"]);
        assert_eq!(
            worktree_labels(&app, "wt-a"),
            vec![label("Defect", true, Some(5))]
        );
        assert_eq!(names(&worktree_labels(&app, "wt-b")), vec!["QA"]);
        assert_eq!(
            session_labels(&app, &s_a),
            vec![label("Defect", false, Some(9))]
        );
        assert_eq!(names(&session_labels(&app, &s_b)), vec!["Defect"]);
        assert_eq!(names(&session_labels(&app, &s_other)), vec!["QA"]);
    }

    #[tokio::test]
    async fn mark_rename_into_an_existing_name_fails_and_changes_nothing() {
        let (temp, app) = test_app();
        let mut wt = worktree(&temp, "wt-a", "project-a");
        wt.labels = vec![label("Bug", false, None)];
        save_worktrees(&app, vec![wt]);
        set_list(&app, &["Bug", "QA"]);

        let error = rename_mark(app.clone(), "Bug".into(), "qa".into())
            .await
            .unwrap_err();

        assert!(error.contains("already exists"), "{error}");
        assert_eq!(list_names(&app), vec!["Bug", "QA"]);
        assert_eq!(names(&worktree_labels(&app, "wt-a")), vec!["Bug"]);
        // Only the case of the same entry changes: allowed.
        rename_mark(app.clone(), "Bug".into(), "bug".into())
            .await
            .unwrap();
        assert_eq!(list_names(&app), vec!["bug", "QA"]);
        assert!(rename_mark(app.clone(), "QA".into(), "  ".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn mark_remove_everywhere_removes_from_list_and_items() {
        let (temp, app) = test_app();
        let mut wt_a = worktree(&temp, "wt-a", "project-a");
        wt_a.labels = vec![label("Bug", false, None), label("QA", false, None)];
        let wt_b = worktree(&temp, "wt-b", "project-b");
        save_worktrees(&app, vec![wt_a, wt_b]);
        let s_b = save_session(&app, "wt-b", vec![label("bug", false, None)], false);
        set_list(&app, &["Bug", "QA"]);

        let usage = remove_mark_everywhere(app.clone(), "BUG".into())
            .await
            .unwrap();

        assert_eq!(
            usage,
            MarkUsage {
                worktrees: 1,
                sessions: 1
            }
        );
        assert_eq!(list_names(&app), vec!["QA"]);
        assert_eq!(names(&worktree_labels(&app, "wt-a")), vec!["QA"]);
        assert!(session_labels(&app, &s_b).is_empty());
    }

    #[tokio::test]
    async fn mark_remove_count_usage_skips_archived_items() {
        let (temp, app) = test_app();
        let mut live = worktree(&temp, "wt-live", "project-a");
        live.labels = vec![label("Bug", false, None)];
        let mut archived = worktree(&temp, "wt-archived", "project-b");
        archived.labels = vec![label("Bug", false, None)];
        archived.archived_at = Some(1);
        save_worktrees(&app, vec![live, archived]);
        save_session(&app, "wt-live", vec![label("bug", false, None)], false);
        save_session(&app, "wt-live", vec![label("Bug", false, None)], true);
        save_session(&app, "wt-archived", vec![label("Bug", false, None)], false);

        let usage = count_mark_usage(app.clone(), "BUG".into()).await.unwrap();

        assert_eq!(
            usage,
            MarkUsage {
                worktrees: 1,
                sessions: 1
            }
        );
    }
}
