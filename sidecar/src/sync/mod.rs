//! Cloud-folder sync (docs/SYNC.md, ADR 0013).
//!
//! The folder is a transport, not a database. Local user state is projected
//! into immutable operations; each device replays every operation into a
//! materialized mirror and projects the mirror back into its own path-keyed
//! catalog.

pub mod capture;
pub mod clock;
pub mod engine;
pub mod identity;
pub mod merge;
pub mod model;
pub mod store;
pub mod waiting;
