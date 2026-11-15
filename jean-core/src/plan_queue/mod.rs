//! Native plan queue: runs `.jean/plans/*.md` one after another.
//!
//! This module holds the pure core (outcome rules, gates, queue files). It is a
//! port of the external `jean-queue` runner, so the file layout and formats stay
//! the same. See `docs/superpowers/specs/2026-11-15-native-plan-queue-design.md`.

pub mod files;
pub mod gates;
pub mod outcome;
