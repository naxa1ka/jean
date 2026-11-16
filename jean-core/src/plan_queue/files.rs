//! Queue files: buckets, moves, `.sid.txt`, next prefix, name checks, reorder.
//! Port of the file helpers in jean-queue `jean-queue.mjs`.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::gates::strip_num_prefix;

// JS `\w` is ASCII only, so spell the class out (Rust `\w` is Unicode).
static NON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.-]+").unwrap());

/// A plan name must be a plain file name that ends in `.md` (any case).
pub fn validate_plan_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("plan name is empty".to_string());
    }
    if name.contains(['/', '\\', ':']) || name.contains("..") || name.starts_with('.') {
        return Err(format!("invalid plan name: {name}"));
    }
    if !name.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("plan name must end in .md: {name}"));
    }
    Ok(())
}

/// Sorted names of the `*.md` files in `dir`. Empty when the folder is missing.
pub fn list_bucket(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.to_ascii_lowercase().ends_with(".md"))
        .collect();
    names.sort();
    names
}

/// Only `.jean/blocked/*.md` counts, so a `.gitkeep` does not block the queue.
pub fn has_blocker_marker(worktree: &Path) -> bool {
    !list_bucket(&worktree.join(".jean").join("blocked")).is_empty()
}

fn dest_path(file: &Path, dest_dir: &Path) -> io::Result<PathBuf> {
    let name = file
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    fs::create_dir_all(dest_dir)?;
    Ok(dest_dir.join(name))
}

/// Moves `file` into `dest_dir` (created if missing). Rename, else copy + delete.
pub fn move_into(file: &Path, dest_dir: &Path) -> io::Result<PathBuf> {
    let dest = dest_path(file, dest_dir)?;
    if fs::rename(file, &dest).is_err() {
        fs::copy(file, &dest)?;
        fs::remove_file(file)?;
    }
    Ok(dest)
}

/// Claims `file` by one rename into `dest_dir`, with no copy fallback. Returns
/// `Err` when the source is gone, e.g. another runner claimed it first.
pub fn claim_atomic(file: &Path, dest_dir: &Path) -> io::Result<PathBuf> {
    let dest = dest_path(file, dest_dir)?;
    fs::rename(file, &dest)?;
    Ok(dest)
}

/// The next 3-digit prefix: max numeric prefix over the pending plans, plus 1.
pub fn next_prefix(plans_dir: &Path) -> String {
    let max = list_bucket(plans_dir)
        .iter()
        .map(|n| {
            let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().unwrap_or(-1)
        })
        .max()
        .unwrap_or(0);
    format!("{:03}", max + 1)
}

pub fn slugify(name: &str) -> String {
    let slug = NON_SLUG
        .replace_all(name.trim(), "-")
        .trim_matches('-')
        .to_lowercase();
    if slug.is_empty() {
        "plan".to_string()
    } else {
        slug
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidFile {
    pub session_id: String,
    pub at: String,
    pub worktree: Option<String>,
    pub head: Option<String>,
    pub reason: Option<String>,
    /// Findings review: phase of the current run (`triage` or `fix`). `head` stays
    /// the start head of the plan phase, so older readers see no change.
    pub phase: Option<String>,
    /// Session id of the current phase (`sessionId` stays the plan session).
    pub phase_sid: Option<String>,
    /// HEAD at the start of the fix run.
    pub phase_head: Option<String>,
}

impl SidFile {
    /// Parses `key=value` lines (`sessionId`, `at`, `worktree`, `head`, `reason`),
    /// as written by jean-queue or by Jean. Unknown keys are ignored.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut sid = SidFile::default();
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let opt = || Some(value.to_string()).filter(|v| !v.is_empty());
            match key {
                "sessionId" => sid.session_id = value.to_string(),
                "at" => sid.at = value.to_string(),
                "worktree" => sid.worktree = opt(),
                // jean-queue writes `head=null` when it could not read HEAD.
                "head" => sid.head = opt().filter(|v| v != "null"),
                "reason" => sid.reason = opt(),
                "phase" => sid.phase = opt(),
                "phaseSid" => sid.phase_sid = opt(),
                "phaseHead" => sid.phase_head = opt().filter(|v| v != "null"),
                _ => {}
            }
        }
        if sid.session_id.is_empty() {
            return Err("sid file has no sessionId".to_string());
        }
        Ok(sid)
    }
}

impl fmt::Display for SidFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "sessionId={}", self.session_id)?;
        writeln!(f, "at={}", self.at)?;
        let optional = [
            ("worktree", &self.worktree),
            ("head", &self.head),
            ("reason", &self.reason),
            ("phase", &self.phase),
            ("phaseSid", &self.phase_sid),
            ("phaseHead", &self.phase_head),
        ];
        for (key, value) in optional {
            if let Some(value) = value {
                writeln!(f, "{key}={value}")?;
            }
        }
        Ok(())
    }
}

/// Renames that put the pending plans in `wanted` order as `001-…`, `002-…`,
/// keeping the part after the old `NNN-` prefix.
///
/// New names can overlap old names (a swap of `001-a` and `002-b`), so the list
/// is two-phase: first every changed plan moves to a temp name, then every temp
/// name moves to its new name. Temp names start with `.` and do not end in
/// `.md`, so they are never plans and never collide with one. Apply the pairs in
/// the returned order. Plans whose name does not change are left out.
pub fn reorder_renames(
    current_pending: &[String],
    wanted: &[String],
) -> Result<Vec<(String, String)>, String> {
    let current: HashSet<&String> = current_pending.iter().collect();
    let wanted_set: HashSet<&String> = wanted.iter().collect();
    if wanted_set.len() != wanted.len()
        || current.len() != current_pending.len()
        || current != wanted_set
    {
        return Err("plan order does not match the pending plans".to_string());
    }

    let changed: Vec<(&String, String)> = wanted
        .iter()
        .enumerate()
        .map(|(i, old)| (old, format!("{:03}-{}", i + 1, strip_num_prefix(old))))
        .filter(|(old, new)| *old != new)
        .collect();

    let mut renames = Vec::with_capacity(changed.len() * 2);
    for (old, new) in &changed {
        renames.push(((*old).clone(), format!(".reorder-{new}.tmp")));
    }
    for (_, new) in changed {
        renames.push((format!(".reorder-{new}.tmp"), new));
    }
    Ok(renames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plan_names_are_validated() {
        for ok in ["001-core.md", "plan.MD", "a b.md", "x.y.md"] {
            assert!(validate_plan_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "core",
            "core.txt",
            "a/b.md",
            "a\\b.md",
            "../x.md",
            "a..b.md",
            "C:x.md",
            ".hidden.md",
            ".md",
        ] {
            assert!(validate_plan_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn list_bucket_returns_sorted_md_files_only() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_bucket(&dir.path().join("missing")).is_empty());
        for n in ["002-b.md", "001-a.MD", "001-a.md.sid.txt", ".gitkeep"] {
            touch(&dir.path().join(n));
        }
        fs::create_dir_all(dir.path().join("done.md")).unwrap();
        assert_eq!(list_bucket(dir.path()), names(&["001-a.MD", "002-b.md"]));
    }

    #[test]
    fn only_md_files_are_blocker_markers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!has_blocker_marker(dir.path()));
        let blocked = dir.path().join(".jean").join("blocked");
        touch(&blocked.join(".gitkeep"));
        touch(&blocked.join("notes.txt"));
        assert!(!has_blocker_marker(dir.path()));
        touch(&blocked.join("BLOCKED-01.md"));
        assert!(has_blocker_marker(dir.path()));
    }

    #[test]
    fn move_into_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("001-a.md");
        touch(&src);
        let dest = move_into(&src, &dir.path().join("done")).unwrap();
        assert_eq!(dest, dir.path().join("done").join("001-a.md"));
        assert!(dest.exists());
        assert!(!src.exists());
    }

    #[test]
    fn claim_atomic_fails_when_source_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("001-a.md");
        touch(&src);
        let running = dir.path().join("running");
        let dest = claim_atomic(&src, &running).unwrap();
        assert!(dest.exists());
        // A second runner tries to claim the same file.
        assert!(claim_atomic(&src, &running).is_err());
        assert!(dest.exists());
    }

    #[test]
    fn next_prefix_is_max_plus_one() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(next_prefix(&dir.path().join("missing")), "001");
        touch(&dir.path().join("003-c.md"));
        touch(&dir.path().join("010-d.md"));
        touch(&dir.path().join("notes.md"));
        // Plans in other buckets do not count.
        touch(&dir.path().join("done").join("050-x.md"));
        assert_eq!(next_prefix(dir.path()), "011");
    }

    #[test]
    fn slugify_matches_jean_queue() {
        assert_eq!(slugify("  My Plan: UI/Check!  "), "my-plan-ui-check");
        assert_eq!(slugify("core_v2.1"), "core_v2.1");
        assert_eq!(slugify("--a--"), "a");
        assert_eq!(slugify("Plän"), "pl-n");
        assert_eq!(slugify(""), "plan");
        assert_eq!(slugify("!!!"), "plan");
    }

    #[test]
    fn sid_file_parses_node_runner_claim() {
        let text = "sessionId=abc-123\nat=2026-11-15T10:00:00.000Z\nworktree=C:\\jean\\p\\wt=1\nhead=deadbeef\n";
        let sid = SidFile::parse(text).unwrap();
        assert_eq!(
            sid,
            SidFile {
                session_id: "abc-123".into(),
                at: "2026-11-15T10:00:00.000Z".into(),
                worktree: Some("C:\\jean\\p\\wt=1".into()),
                head: Some("deadbeef".into()),
                reason: None,
                ..SidFile::default()
            }
        );
        assert_eq!(sid.to_string(), text);
    }

    #[test]
    fn sid_file_parses_node_runner_failure() {
        let text = "sessionId=s1\r\nat=2026-11-15T10:00:00.000Z\r\nreason=no new commit on worktree HEAD\r\n";
        let sid = SidFile::parse(text).unwrap();
        assert_eq!(
            sid.reason.as_deref(),
            Some("no new commit on worktree HEAD")
        );
        assert_eq!(sid.worktree, None);
        assert_eq!(
            sid.to_string(),
            "sessionId=s1\nat=2026-11-15T10:00:00.000Z\nreason=no new commit on worktree HEAD\n"
        );
    }

    #[test]
    fn sid_file_round_trips_the_phase_keys() {
        let text = "sessionId=plan-s
at=t
head=h0
phase=fix
phaseSid=fix-s
phaseHead=h1
";
        let sid = SidFile::parse(text).unwrap();
        assert_eq!(sid.phase.as_deref(), Some("fix"));
        assert_eq!(sid.phase_sid.as_deref(), Some("fix-s"));
        assert_eq!(sid.phase_head.as_deref(), Some("h1"));
        assert_eq!(sid.to_string(), text);
    }

    #[test]
    fn sid_file_with_phase_keys_keeps_session_and_head() {
        // What an older reader looks at: sessionId and head keep their meaning.
        let sid = SidFile::parse(
            "sessionId=plan-s
at=t
head=h0
phase=triage
phaseSid=t-s
",
        )
        .unwrap();
        assert_eq!(sid.session_id, "plan-s");
        assert_eq!(sid.head.as_deref(), Some("h0"));
        // A Node runner file has none of the new keys.
        let node = SidFile::parse(
            "sessionId=s
at=t
head=h
",
        )
        .unwrap();
        assert_eq!(
            (node.phase, node.phase_sid, node.phase_head),
            (None, None, None)
        );
    }

    #[test]
    fn sid_file_treats_null_head_as_none() {
        // Node writes `head=null` when it could not read HEAD.
        let sid = SidFile::parse("sessionId=s1\nat=t\nhead=null\n").unwrap();
        assert_eq!(sid.head, None);
    }

    #[test]
    fn sid_file_needs_a_session_id() {
        assert!(SidFile::parse("at=t\n").is_err());
        assert!(SidFile::parse("sessionId=\n").is_err());
    }

    #[test]
    fn reorder_rejects_a_different_set() {
        let cur = names(&["001-a.md", "002-b.md"]);
        assert!(reorder_renames(&cur, &names(&["001-a.md"])).is_err());
        assert!(reorder_renames(&cur, &names(&["001-a.md", "003-c.md"])).is_err());
        assert!(reorder_renames(&cur, &names(&["001-a.md", "001-a.md"])).is_err());
    }

    #[test]
    fn reorder_renumbers_and_is_safe_with_overlapping_names() {
        let dir = tempfile::tempdir().unwrap();
        // Swap 001-a and 002-b: the new names overlap the old ones.
        let cur = names(&["001-a.md", "002-b.md", "003-c.md", "d.md"]);
        for n in &cur {
            fs::write(dir.path().join(n), n).unwrap();
        }
        let wanted = names(&["002-b.md", "001-a.md", "003-c.md", "d.md"]);
        let renames = reorder_renames(&cur, &wanted).unwrap();
        for (from, to) in &renames {
            let to = dir.path().join(to);
            assert!(!to.exists(), "rename target {to:?} already exists");
            fs::rename(dir.path().join(from), to).unwrap();
        }
        assert_eq!(
            list_bucket(dir.path()),
            names(&["001-b.md", "002-a.md", "003-c.md", "004-d.md"])
        );
        // The content follows the plan.
        assert_eq!(
            fs::read_to_string(dir.path().join("001-b.md")).unwrap(),
            "002-b.md"
        );
        // No temp file is left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 4);
    }

    #[test]
    fn reorder_skips_unchanged_names() {
        let cur = names(&["001-a.md", "002-b.md"]);
        assert!(reorder_renames(&cur, &cur).unwrap().is_empty());
    }
}
