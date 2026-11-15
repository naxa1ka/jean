//! Which queue bucket a finished plan session goes to. Pure, no IO.
//! Port of jean-queue `outcome.mjs` (`decideOutcome`).

/// A session that never ran is sent again up to this many times in total, then it fails.
pub const MAX_UNSTARTED_TRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    Done,
    Failed,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFacts {
    pub status: RunEnd,
    /// `.jean/blocked/` has a `*.md` file.
    pub blocked: bool,
    /// Worktree HEAD now.
    pub head: Option<String>,
    /// Worktree HEAD when the plan was claimed.
    pub start_head: Option<String>,
    /// `Some(false)` = the session was never seen running; `None` = not known
    /// (startup recovery), which keeps the old rule.
    pub seen_running: Option<bool>,
    /// Earlier "never ran" tries of this plan.
    pub tries: u32,
}

/// Returns the bucket and a reason (empty for done). Same branch order and
/// reason texts as `outcome.mjs`.
pub fn decide_outcome(run: &RunFacts) -> (Bucket, String) {
    if run.status == RunEnd::Error {
        return (Bucket::Failed, "session error".to_string());
    }
    if run.blocked {
        return (
            Bucket::Failed,
            "blocker marker in .jean/blocked/".to_string(),
        );
    }
    let Some(head) = run.head.as_deref().filter(|h| !h.is_empty()) else {
        return (Bucket::Failed, "cannot read git HEAD".to_string());
    };
    let start_head = run.start_head.as_deref().filter(|h| !h.is_empty());
    if let Some(start) = start_head {
        if head != start {
            return (Bucket::Done, String::new());
        }
        // The plan message was probably lost. Send it again, but do not let the
        // next plan start: it would run without this one.
        if run.seen_running == Some(false) {
            let n = run.tries + 1;
            if n < MAX_UNSTARTED_TRIES {
                return (
                    Bucket::Pending,
                    format!("session never ran (try {n}); plan re-queued"),
                );
            }
            return (Bucket::Failed, format!("session never ran ({n} tries)"));
        }
    }
    (Bucket::Failed, "no new commit on worktree HEAD".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> RunFacts {
        RunFacts {
            status: RunEnd::Done,
            blocked: false,
            head: Some("b".into()),
            start_head: Some("a".into()),
            seen_running: Some(true),
            tries: 0,
        }
    }

    #[test]
    fn new_commit_means_done() {
        assert_eq!(decide_outcome(&base()), (Bucket::Done, String::new()));
    }

    #[test]
    fn session_error_fails_even_with_new_commit() {
        let run = RunFacts {
            status: RunEnd::Error,
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (Bucket::Failed, "session error".into())
        );
    }

    #[test]
    fn blocker_marker_fails_the_plan() {
        let run = RunFacts {
            blocked: true,
            seen_running: Some(false),
            head: Some("a".into()),
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (Bucket::Failed, "blocker marker in .jean/blocked/".into())
        );
    }

    #[test]
    fn missing_head_fails() {
        let run = RunFacts {
            head: None,
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (Bucket::Failed, "cannot read git HEAD".into())
        );
    }

    #[test]
    fn ran_without_commit_fails() {
        let run = RunFacts {
            head: Some("a".into()),
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (Bucket::Failed, "no new commit on worktree HEAD".into())
        );
    }

    #[test]
    fn never_ran_goes_back_to_pending() {
        let run = RunFacts {
            head: Some("a".into()),
            seen_running: Some(false),
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (
                Bucket::Pending,
                "session never ran (try 1); plan re-queued".into()
            )
        );
    }

    #[test]
    fn never_ran_fails_after_last_try() {
        let run = RunFacts {
            head: Some("a".into()),
            seen_running: Some(false),
            tries: MAX_UNSTARTED_TRIES - 1,
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (
                Bucket::Failed,
                format!("session never ran ({MAX_UNSTARTED_TRIES} tries)")
            )
        );
    }

    #[test]
    fn unknown_run_state_keeps_old_rule() {
        let run = RunFacts {
            head: Some("a".into()),
            seen_running: None,
            ..base()
        };
        assert_eq!(decide_outcome(&run).0, Bucket::Failed);
    }

    #[test]
    fn no_start_head_keeps_old_rule() {
        let run = RunFacts {
            start_head: None,
            seen_running: Some(false),
            ..base()
        };
        assert_eq!(
            decide_outcome(&run),
            (Bucket::Failed, "no new commit on worktree HEAD".into())
        );
    }
}
