//! Reset, Forget, and the 30-day book trash (ADR 0014 D5, ticket
//! tuxbooks-ip6.7).
//!
//! Reset keeps the durable identity and clears what the user owns. Forget
//! snapshots the whole book, deletes the identity, and, when a file row is
//! still in the library, rebinds it to a fresh record so the entry never
//! disappears. The snapshot lives in `book_trash`, separate from `sync_trash`
//! (which holds one annotation or collection entity per row).
//!
//! The module is split by motion: `snapshot` reads a book into the portable
//! shape and shapes a shared snapshot back into rows, `forget` and `restore`
//! are the user-facing moves, `state` replays a snapshot into the durable
//! tables, `merge` folds two identities, and `remote` applies what another
//! machine shared.

mod forget;
mod merge;
mod remote;
mod restore;
mod snapshot;
mod state;
#[cfg(test)]
mod tests;

pub use forget::{forget, reset};
pub use remote::{apply_remote_discard, apply_remote_forget, apply_remote_restore};
pub use restore::{list_trash, restore};
pub use snapshot::shared_snapshot_json;

use chrono::{Duration, Utc};

use crate::sync::model::TRASH_DAYS;

fn now() -> String {
    crate::sync::clock::now_rfc3339()
}

fn expires_at() -> String {
    (Utc::now() + Duration::days(TRASH_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
