//! Findings review: phases after a plan run (plan -> triage -> fix). Pure, no IO.
//!
//! Design: `docs/superpowers/specs/2026-11-16-plan-queue-mcp-findings-design.md`,
//! section 3. The loop guard is structural: `after_phase(Fix, ..)` returns only
//! `Finish`, and an unknown phase on disk maps to `Fix`.

use std::path::{Path, PathBuf};

use super::files::SidFile;
use super::outcome::{Bucket, RunEnd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Plan,
    Triage,
    Fix,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Plan => "plan",
            Phase::Triage => "triage",
            Phase::Fix => "fix",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "plan" => Some(Phase::Plan),
            "triage" => Some(Phase::Triage),
            "fix" => Some(Phase::Fix),
            _ => None,
        }
    }

    /// Prefix of a failure reason of this phase.
    pub fn reason_prefix(self) -> &'static str {
        match self {
            Phase::Plan => "",
            Phase::Triage => "findings triage: ",
            Phase::Fix => "findings fix: ",
        }
    }
}

/// The plan stem: the file name without its last 3 characters (`.md`, any case).
pub fn plan_stem(plan_file_name: &str) -> &str {
    let len = plan_file_name.len();
    if len >= 3 && plan_file_name.is_char_boundary(len - 3) {
        &plan_file_name[..len - 3]
    } else {
        plan_file_name
    }
}

/// `<worktree>/.jean/findings/<plan file name>`
pub fn findings_path(worktree: &Path, plan_file_name: &str) -> PathBuf {
    worktree.join(".jean").join("findings").join(plan_file_name)
}

/// `<worktree>/.jean/findings/<plan stem>.fix.md`
pub fn fix_plan_path(worktree: &Path, plan_file_name: &str) -> PathBuf {
    worktree
        .join(".jean")
        .join("findings")
        .join(format!("{}.fix.md", plan_stem(plan_file_name)))
}

/// Outcome of a triage run. It makes no commit, so it does not use `decide_outcome`.
pub fn triage_outcome(end: RunEnd, blocked: bool, seen_running: Option<bool>) -> (Bucket, String) {
    if end == RunEnd::Error {
        return (Bucket::Failed, "session error".to_string());
    }
    if blocked {
        return (
            Bucket::Failed,
            "blocker marker in .jean/blocked/".to_string(),
        );
    }
    if seen_running == Some(false) {
        return (Bucket::Failed, "session never ran".to_string());
    }
    (Bucket::Done, String::new())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    Start(Phase),
    Finish(Bucket, String),
}

/// What happens after the run of `phase` ended with `outcome`.
pub fn after_phase(
    phase: Phase,
    outcome: (Bucket, String),
    fix_findings: bool,
    findings_exists: bool,
    fix_plan_exists: bool,
) -> Next {
    let (bucket, reason) = outcome;
    match phase {
        Phase::Plan => {
            if bucket == Bucket::Done && fix_findings && findings_exists {
                Next::Start(Phase::Triage)
            } else {
                Next::Finish(bucket, reason)
            }
        }
        Phase::Triage => {
            if bucket != Bucket::Done {
                Next::Finish(Bucket::Failed, format!("findings triage: {reason}"))
            } else if fix_plan_exists {
                Next::Start(Phase::Fix)
            } else {
                Next::Finish(Bucket::Done, String::new())
            }
        }
        Phase::Fix => match bucket {
            Bucket::Done => Next::Finish(Bucket::Done, String::new()),
            Bucket::Pending => Next::Finish(
                Bucket::Failed,
                "findings fix: session never ran".to_string(),
            ),
            Bucket::Failed => Next::Finish(Bucket::Failed, format!("findings fix: {reason}")),
        },
    }
}

/// The session to check and the phase of a plan found in `running/`.
/// A `phaseSid` with a missing or unknown `phase` maps to `Fix`, so a damaged
/// file can never start a phase.
pub fn recovery_target(sid: &SidFile) -> (String, Phase) {
    match &sid.phase_sid {
        None => (sid.session_id.clone(), Phase::Plan),
        Some(phase_sid) => {
            let phase = sid
                .phase
                .as_deref()
                .and_then(Phase::parse)
                .unwrap_or(Phase::Fix);
            (phase_sid.clone(), phase)
        }
    }
}

/// Appended to the plan message (only in `start_plan`) when findings review is on.
pub fn report_instruction(plan_file_name: &str) -> String {
    format!(
        "When the work of this plan is complete, write every finding from it (bugs, failed or \
skipped checks, risks, security issues, gaps against 'Done when') to \
`.jean/findings/{plan_file_name}` (create the directory): one block per finding with finding, \
location, impact and suggestion. If there are no findings, do not create the file. Do not commit \
this file."
    )
}

pub fn triage_prompt(plan_text: &str, plan_file_name: &str, start_head: Option<&str>) -> String {
    let stem = plan_stem(plan_file_name);
    let diff = match start_head {
        Some(head) => format!("`git diff {head}..HEAD`"),
        None => "the diff against the base branch that the plan names".to_string(),
    };
    format!(
        "You are a separate reviewer of a finished plan-queue slice. Read the plan below, the \
changes ({diff}) and `.jean/findings/{plan_file_name}`. Do not change, commit or push code in \
this session.\n\n\
For each finding decide: is it real (verify it in the code), is it in the scope of this slice \
(caused by its changes, or necessary for its Goal / \"Done when\"), is a fix worth it now. Write \
`fix` or `no fix` and a one-line reason under a `## Triage` heading in the findings file.\n\n\
If at least one finding is `fix`: write a cold-start fix plan to `.jean/findings/{stem}.fix.md` \
with Goal, Context (repo path, the current branch, files to read), Steps, Verification (the \
commands of the slice), Done when and a Stop rule. The plan must tell its reader to make at \
least one new commit, to push to the current branch, to open no new branch or PR, and to write \
`.jean/blocked/<name>.md` when blocked.\n\n\
If no finding is `fix`: do not write a fix plan. Findings out of scope stay in the findings file \
for the user.\n\n\
--- PLAN START ---\n{plan_text}\n--- PLAN END ---"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done() -> (Bucket, String) {
        (Bucket::Done, String::new())
    }

    #[test]
    fn phase_round_trips() {
        for p in [Phase::Plan, Phase::Triage, Phase::Fix] {
            assert_eq!(Phase::parse(p.as_str()), Some(p));
        }
        assert_eq!(Phase::parse("loop"), None);
    }

    #[test]
    fn paths_use_the_plan_file_name_and_stem() {
        let wt = Path::new("wt");
        assert_eq!(
            findings_path(wt, "003-fix-login.md"),
            Path::new("wt/.jean/findings/003-fix-login.md")
        );
        assert_eq!(
            fix_plan_path(wt, "003-fix-login.MD"),
            Path::new("wt/.jean/findings/003-fix-login.fix.md")
        );
    }

    #[test]
    fn triage_outcome_rules() {
        assert_eq!(
            triage_outcome(RunEnd::Error, true, Some(false)),
            (Bucket::Failed, "session error".into())
        );
        assert_eq!(
            triage_outcome(RunEnd::Done, true, Some(false)),
            (Bucket::Failed, "blocker marker in .jean/blocked/".into())
        );
        assert_eq!(
            triage_outcome(RunEnd::Done, false, Some(false)),
            (Bucket::Failed, "session never ran".into())
        );
        assert_eq!(triage_outcome(RunEnd::Done, false, Some(true)), done());
        assert_eq!(triage_outcome(RunEnd::Done, false, None), done());
    }

    #[test]
    fn plan_done_with_findings_starts_triage() {
        assert_eq!(
            after_phase(Phase::Plan, done(), true, true, false),
            Next::Start(Phase::Triage)
        );
    }

    #[test]
    fn plan_without_findings_file_finishes() {
        assert_eq!(
            after_phase(Phase::Plan, done(), true, false, false),
            Next::Finish(Bucket::Done, String::new())
        );
    }

    #[test]
    fn plan_not_done_finishes_unchanged() {
        for outcome in [
            (Bucket::Failed, "no new commit on worktree HEAD".to_string()),
            (Bucket::Pending, "session never ran (try 1)".to_string()),
        ] {
            assert_eq!(
                after_phase(Phase::Plan, outcome.clone(), true, true, true),
                Next::Finish(outcome.0, outcome.1)
            );
        }
    }

    #[test]
    fn plan_with_switch_off_never_starts_triage() {
        assert_eq!(
            after_phase(Phase::Plan, done(), false, true, true),
            Next::Finish(Bucket::Done, String::new())
        );
    }

    #[test]
    fn triage_failure_is_prefixed() {
        assert_eq!(
            after_phase(
                Phase::Triage,
                (Bucket::Failed, "session error".into()),
                true,
                true,
                true
            ),
            Next::Finish(Bucket::Failed, "findings triage: session error".into())
        );
    }

    #[test]
    fn triage_with_fix_plan_starts_fix() {
        assert_eq!(
            after_phase(Phase::Triage, done(), true, true, true),
            Next::Start(Phase::Fix)
        );
    }

    #[test]
    fn triage_without_fix_plan_is_done() {
        assert_eq!(
            after_phase(Phase::Triage, done(), true, true, false),
            Next::Finish(Bucket::Done, String::new())
        );
    }

    #[test]
    fn fix_outcomes() {
        assert_eq!(
            after_phase(Phase::Fix, done(), true, true, true),
            Next::Finish(Bucket::Done, String::new())
        );
        assert_eq!(
            after_phase(Phase::Fix, (Bucket::Pending, "x".into()), true, true, true),
            Next::Finish(Bucket::Failed, "findings fix: session never ran".into())
        );
        assert_eq!(
            after_phase(
                Phase::Fix,
                (Bucket::Failed, "no new commit on worktree HEAD".into()),
                true,
                true,
                true
            ),
            Next::Finish(
                Bucket::Failed,
                "findings fix: no new commit on worktree HEAD".into()
            )
        );
    }

    #[test]
    fn fix_never_starts_a_phase() {
        let outcomes = [
            done(),
            (Bucket::Failed, "r".to_string()),
            (Bucket::Pending, "r".to_string()),
        ];
        for outcome in outcomes {
            for bits in 0..8u8 {
                let next = after_phase(
                    Phase::Fix,
                    outcome.clone(),
                    bits & 1 != 0,
                    bits & 2 != 0,
                    bits & 4 != 0,
                );
                assert!(matches!(next, Next::Finish(..)), "{outcome:?} {bits}");
            }
        }
    }

    fn sid(phase: Option<&str>, phase_sid: Option<&str>) -> SidFile {
        SidFile {
            session_id: "plan-sid".into(),
            phase: phase.map(str::to_string),
            phase_sid: phase_sid.map(str::to_string),
            ..SidFile::default()
        }
    }

    #[test]
    fn recovery_target_rules() {
        assert_eq!(
            recovery_target(&sid(None, None)),
            ("plan-sid".to_string(), Phase::Plan)
        );
        // A phase without phaseSid is ignored: the plan session is the target.
        assert_eq!(
            recovery_target(&sid(Some("fix"), None)),
            ("plan-sid".to_string(), Phase::Plan)
        );
        assert_eq!(
            recovery_target(&sid(Some("triage"), Some("t-sid"))),
            ("t-sid".to_string(), Phase::Triage)
        );
        assert_eq!(
            recovery_target(&sid(Some("fix"), Some("f-sid"))),
            ("f-sid".to_string(), Phase::Fix)
        );
        assert_eq!(
            recovery_target(&sid(None, Some("x-sid"))),
            ("x-sid".to_string(), Phase::Fix)
        );
        assert_eq!(
            recovery_target(&sid(Some("bogus"), Some("x-sid"))),
            ("x-sid".to_string(), Phase::Fix)
        );
    }
}
