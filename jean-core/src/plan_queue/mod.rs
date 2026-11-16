//! Native plan queue: runs `.jean/plans/*.md` one after another.
//!
//! The pure core (outcome rules, gates, queue files) and the background
//! `scheduler` that runs the queues. Both port the external `jean-queue` runner,
//! so the file layout and formats stay the same. See `docs/superpowers/specs/2026-11-15-native-plan-queue-design.md`.

pub mod commands;
pub mod files;
pub mod findings;
pub mod gates;
pub mod outcome;
pub mod scheduler;
