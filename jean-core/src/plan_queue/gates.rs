//! Dependency gates in the plan header. Port of jean-queue `parseNeeds` / `needsMet`.
//!
//! Gate lines are read only from the first [`GATE_HEADER_LINES`] lines of a plan:
//! - `<!-- needs-slice: <slug> -->`: the slug (`NNN-` prefix optional) is in `done/`.
//! - `<!-- needs-file: <repo> <ref> <file> <text> -->`: `git show <ref>:<file>` in
//!   `<repo>` (resolved against the worktree) contains `<text>`.
//!
//! A malformed line goes to `bad` and the gate fails closed.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use super::files::list_bucket;
use crate::platform::{output_with_timeout, silent_command};

pub const GATE_HEADER_LINES: usize = 5;
const GIT_SHOW_TIMEOUT: Duration = Duration::from_secs(10);

static NEEDS_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!--\s*needs-(slice|file):\s*(.*?)\s*-->\s*$").unwrap());
static NEEDS_FILE_ARGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"(.*)"$"#).unwrap());
static NUM_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+-").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsFile {
    pub repo: String,
    pub git_ref: String,
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Needs {
    pub slices: Vec<String>,
    pub files: Vec<NeedsFile>,
    /// Malformed gate lines (trimmed). Any entry makes the gate fail closed.
    pub bad: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateResult {
    pub met: bool,
    /// Stable text (no timestamps), so a WAIT log can dedupe on it. Empty when met.
    pub reason: String,
}

impl GateResult {
    fn wait(reason: String) -> Self {
        Self { met: false, reason }
    }
}

/// Strips a leading `NNN-` prefix, as jean-queue does for slice names.
pub(crate) fn strip_num_prefix(name: &str) -> &str {
    match NUM_PREFIX.find(name) {
        Some(m) => &name[m.end()..],
        None => name,
    }
}

pub fn parse_needs(text: &str) -> Needs {
    let mut needs = Needs::default();
    // `str::lines` splits on `\n` and strips a trailing `\r`, like `/\r?\n/`.
    for line in text.lines().take(GATE_HEADER_LINES) {
        let line = line.trim();
        let Some(caps) = NEEDS_LINE.captures(line) else {
            continue;
        };
        let value = &caps[2];
        if &caps[1] == "slice" {
            if value.is_empty() {
                needs.bad.push(line.to_string());
            } else {
                needs.slices.push(value.to_string());
            }
            continue;
        }
        let Some(f) = NEEDS_FILE_ARGS.captures(value) else {
            needs.bad.push(line.to_string());
            continue;
        };
        let text = QUOTED.replace(&f[4], "$1").into_owned();
        needs.files.push(NeedsFile {
            repo: f[1].to_string(),
            git_ref: f[2].to_string(),
            path: f[3].to_string(),
            text,
        });
    }
    needs
}

pub fn needs_met(needs: &Needs, plans_dir: &Path, worktree_path: &Path) -> GateResult {
    if let Some(bad) = needs.bad.first() {
        return GateResult::wait(format!("bad gate line: {bad}"));
    }
    let done_names = list_bucket(&plans_dir.join("done"));
    for slug in &needs.slices {
        let want = format!("{}.md", strip_num_prefix(slug));
        if !done_names.iter().any(|n| strip_num_prefix(n) == want) {
            return GateResult::wait(format!("slice {slug} not in done/"));
        }
    }
    for f in &needs.files {
        // Like `path.resolve`: an absolute repo path replaces the worktree path.
        let repo = worktree_path.join(&f.repo);
        let spec = format!("{}:{}", f.git_ref, f.path);
        let mut cmd = silent_command("git");
        cmd.arg("-C")
            .arg(&repo)
            .args(["show", &spec])
            .stdin(std::process::Stdio::null());
        let out = match output_with_timeout(&mut cmd, GIT_SHOW_TIMEOUT) {
            Ok((out, false)) if out.status.success() => out,
            _ => {
                return GateResult::wait(format!("git show {spec} failed in {}", f.repo));
            }
        };
        if !String::from_utf8_lossy(&out.stdout).contains(&f.text) {
            return GateResult::wait(format!("\"{}\" not in {spec}", f.text));
        }
    }
    GateResult {
        met: true,
        reason: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn parses_slice_and_file_gates() {
        let text = "<!-- model: claude-opus-5-5 -->\n<!-- needs-slice: 001-core -->\r\n  <!-- needs-file: ../other main src/a.rs \"fn main\" -->\n# Title\n";
        let needs = parse_needs(text);
        assert_eq!(needs.slices, vec!["001-core".to_string()]);
        assert_eq!(
            needs.files,
            vec![NeedsFile {
                repo: "../other".into(),
                git_ref: "main".into(),
                path: "src/a.rs".into(),
                text: "fn main".into(),
            }]
        );
        assert!(needs.bad.is_empty());
    }

    #[test]
    fn gate_on_line_six_is_ignored() {
        let text = "1\n2\n3\n4\n5\n<!-- needs-slice: core -->\n";
        assert_eq!(parse_needs(text), Needs::default());
        let text = "1\n2\n3\n4\n<!-- needs-slice: core -->\n";
        assert_eq!(parse_needs(text).slices, vec!["core".to_string()]);
    }

    #[test]
    fn bad_needs_file_line_fails_closed() {
        let needs = parse_needs("<!-- needs-file: repo main -->\n");
        assert_eq!(
            needs.bad,
            vec!["<!-- needs-file: repo main -->".to_string()]
        );
        let dir = tempfile::tempdir().unwrap();
        let res = needs_met(&needs, &dir.path().join("plans"), dir.path());
        assert_eq!(
            res,
            GateResult {
                met: false,
                reason: "bad gate line: <!-- needs-file: repo main -->".into()
            }
        );
    }

    #[test]
    fn empty_needs_slice_is_bad() {
        let needs = parse_needs("<!-- needs-slice: -->\n");
        assert!(needs.slices.is_empty());
        assert_eq!(needs.bad.len(), 1);
    }

    #[test]
    fn needs_slice_prefix_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("plans");
        write(&plans.join("done").join("001-core.md"), "x");
        // A .sid.txt next to a done plan is not a plan.
        write(&plans.join("done").join("002-ui.md.sid.txt"), "x");

        for slug in ["core", "001-core", "007-core"] {
            let needs = parse_needs(&format!("<!-- needs-slice: {slug} -->"));
            assert!(needs_met(&needs, &plans, dir.path()).met, "{slug}");
        }
        let needs = parse_needs("<!-- needs-slice: 002-ui -->");
        assert_eq!(
            needs_met(&needs, &plans, dir.path()),
            GateResult {
                met: false,
                reason: "slice 002-ui not in done/".into()
            }
        );
    }

    #[test]
    fn no_gates_are_met() {
        let dir = tempfile::tempdir().unwrap();
        let res = needs_met(&Needs::default(), &dir.path().join("plans"), dir.path());
        assert_eq!(
            res,
            GateResult {
                met: true,
                reason: String::new()
            }
        );
    }

    fn git(repo: &Path, args: &[&str]) {
        let out = silent_command("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn needs_file_reads_git_show_in_a_temp_repo() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().join("wt");
        let repo = dir.path().join("repo");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        write(&repo.join("src").join("a.rs"), "pub fn ready() {}\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let plans = worktree.join(".jean").join("plans");

        let met = parse_needs("<!-- needs-file: ../repo main src/a.rs \"pub fn ready\" -->");
        assert!(needs_met(&met, &plans, &worktree).met);

        let missing_text = parse_needs("<!-- needs-file: ../repo main src/a.rs not_here -->");
        assert_eq!(
            needs_met(&missing_text, &plans, &worktree).reason,
            "\"not_here\" not in main:src/a.rs"
        );

        let missing_file = parse_needs("<!-- needs-file: ../repo main src/b.rs x -->");
        assert_eq!(
            needs_met(&missing_file, &plans, &worktree).reason,
            "git show main:src/b.rs failed in ../repo"
        );
    }
}
