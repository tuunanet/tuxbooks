//! Filesystem watcher (ROADMAP milestone 3): collects raw inotify events,
//! debounces them into coherent batches (with rename pairing), and feeds the
//! resulting [`PathChange`]s to the reconciler. Reconciliation runs on its
//! own thread so the rest of the app never blocks on the filesystem.
//!
//! Design notes:
//! - `watch()` registers roots synchronously on the notify watcher (thread
//!   safe by contract), so a root is guaranteed observed once `watch()`
//!   returns — no event races at startup. `unwatch()` withdraws one again
//!   and re-registers any nested root the recursive removal took down.
//! - one *reconciler* thread drains events with a quiet-period debounce;
//!   rename sources survive flush boundaries so `From`/`To` halves that
//!   straddle windows still pair up.
//! - batching is fs-truth based: duplicate create/delete noise collapses
//!   because reconciliation always compares against what is actually on disk.
//! - this module must not import a UI runtime; UI notification happens through the
//!   reconciler's change callback (wired to IPC in `lib.rs`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::Watcher;

use crate::error::AppError;
use crate::services::library_reconciler::{PathChange, Reconciler};

/// Batches larger than this flush immediately instead of waiting for the
/// quiet period, bounding memory during mass changes (e.g. bulk copies).
const FORCE_FLUSH_LIMIT: usize = 512;

pub struct WatcherConfig {
    pub reconciler: Arc<Reconciler>,
    /// Quiet period after the last event before a batch is reconciled.
    pub debounce: Duration,
}

/// Handle to the running watcher. Dropping it stops event delivery and winds
/// the reconciler thread down once its event channel disconnects.
pub struct LibraryWatcher {
    inner: Mutex<Option<WatcherHandle>>,
}

/// The notify watcher plus the roots the app asked for. The root set is what
/// lets a nested location survive its parent's [`LibraryWatcher::unwatch`]:
/// notify drops every watch under a path, including one a subfolder
/// registered for itself. The reconciler thread is owned here so dropping
/// the watcher can join it before the runtime it borrows goes away.
struct WatcherHandle {
    watcher: notify::RecommendedWatcher,
    roots: HashSet<PathBuf>,
    thread: std::thread::JoinHandle<()>,
}

impl std::fmt::Debug for LibraryWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LibraryWatcher").finish_non_exhaustive()
    }
}

impl LibraryWatcher {
    /// Spawn the reconciler thread. Fails only when the platform watcher or
    /// the worker thread cannot be created, which is a hard setup error.
    pub fn start(config: WatcherConfig) -> Result<Self, AppError> {
        let (event_tx, event_rx) = channel();
        let inner =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            })
            .map_err(io_error)?;

        let reconciler = config.reconciler;
        let debounce = config.debounce;
        let thread = spawn_thread("library-reconciler", move || {
            run_reconciler_loop(event_rx, reconciler, debounce);
        })?;

        Ok(Self {
            inner: Mutex::new(Some(WatcherHandle {
                watcher: inner,
                roots: HashSet::new(),
                thread,
            })),
        })
    }

    /// Start watching `root` recursively. Returns after the watch is
    /// registered — subsequent filesystem changes on `root` are observed.
    /// Safe to call repeatedly for the same root.
    pub fn watch(&self, root: &Path) {
        let mut slot = self.inner.lock().expect("watcher mutex poisoned");
        let handle = slot.as_mut().expect("watcher already dropped");
        handle.roots.insert(root.to_path_buf());
        register(&mut handle.watcher, root);
    }

    /// Stop watching `root` recursively. A root that was never registered —
    /// a folder already gone from disk when the app started — has nothing to
    /// remove, so a missing watch is not an error. Roots the app registered
    /// *inside* `root` are re-registered: notify's recursive unwatch takes
    /// them down with the parent, but they are separate watched folders and
    /// must keep syncing on their own.
    pub fn unwatch(&self, root: &Path) {
        self.unwatch_all(&[root.to_path_buf()]);
    }

    /// Stop watching several roots as one operation — the set a cascading
    /// unwatch sends (ADR 0010). Every dying root leaves the registered set
    /// *before* any notify unwatch runs, so a subfolder going with its
    /// parent is never re-registered on the way out; only the survivors
    /// nested under a dropped root are, which is what [`Self::unwatch`]
    /// repairs for a single root.
    pub fn unwatch_all(&self, roots: &[PathBuf]) {
        let mut slot = self.inner.lock().expect("watcher mutex poisoned");
        let handle = slot.as_mut().expect("watcher already dropped");
        for root in roots {
            handle.roots.remove(root);
        }
        for root in roots {
            let survivors: Vec<PathBuf> = handle
                .roots
                .iter()
                .filter(|candidate| candidate.starts_with(root))
                .cloned()
                .collect();

            if let Err(err) = handle.watcher.unwatch(root) {
                eprintln!("watcher: cannot unwatch {}: {err}", root.display());
            }
            for survivor in survivors {
                register(&mut handle.watcher, &survivor);
            }
        }
    }
}

impl Drop for LibraryWatcher {
    fn drop(&mut self) {
        // Drop the handle to disconnect the event channel, then join before the
        // runtime shuts down, or the thread wakes into a shutdown Tokio context (bd tuxbooks-crn).
        let slot = self.inner.lock().expect("watcher mutex poisoned").take();
        if let Some(WatcherHandle {
            watcher,
            roots: _,
            thread,
        }) = slot
        {
            drop(watcher);
            let _ = thread.join();
        }
    }
}

fn register(watcher: &mut notify::RecommendedWatcher, root: &Path) {
    if let Err(err) = watcher.watch(root, notify::RecursiveMode::Recursive) {
        eprintln!("watcher: cannot watch {}: {err}", root.display());
    }
}

fn io_error(err: notify::Error) -> std::io::Error {
    std::io::Error::other(err.to_string())
}

fn spawn_thread(
    name: &str,
    body: impl FnOnce() + Send + 'static,
) -> Result<std::thread::JoinHandle<()>, AppError> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(body)
        .map_err(|err| AppError::Io(std::io::Error::other(err.to_string())))
}

fn run_reconciler_loop(
    events: Receiver<notify::Event>,
    reconciler: Arc<Reconciler>,
    debounce: Duration,
) {
    let mut batch = EventBatch::default();
    loop {
        match events.recv_timeout(debounce) {
            Ok(event) => {
                // Backend lost events (queue overflow): flush, then reconcile every location.
                if event.flag() == Some(notify::event::Flag::Rescan) {
                    flush(&mut batch, &reconciler);
                    reconciler.block_on(reconciler.reconcile_all_locations());
                    continue;
                }
                batch.absorb(&event);
                if batch.len() >= FORCE_FLUSH_LIMIT {
                    flush(&mut batch, &reconciler);
                }
            }
            Err(RecvTimeoutError::Timeout) => flush(&mut batch, &reconciler),
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn flush(batch: &mut EventBatch, reconciler: &Reconciler) {
    let changes = batch.take();
    if !changes.is_empty() {
        if std::env::var_os("TUXBOOKS_DEBUG_IPC").is_some() {
            eprintln!(
                "sidecar[{}]: flush {} change(s): {:?}",
                std::process::id(),
                changes.len(),
                changes
            );
        }
        reconciler.block_on(reconciler.apply(changes));
    }
    // An expired rename source means the destination event may have been lost
    // (watch registered too late); sweep all locations so the relink is recovered.
    if !batch.expired_froms.is_empty() {
        batch.expired_froms.clear();
        reconciler.block_on(reconciler.reconcile_all_locations());
    }
}

/// Accumulated raw events for one debounce window, resolved into
/// [`PathChange`]s at flush time.
#[derive(Default)]
struct EventBatch {
    creates: Vec<PathBuf>,
    modifies: Vec<PathBuf>,
    removes: Vec<PathBuf>,
    rename_froms: Vec<PathBuf>,
    rename_tos: Vec<PathBuf>,
    /// Rename sources from earlier windows whose destination has not been
    /// seen yet. Under load the From and To halves of one `fs::rename` can
    /// straddle a flush boundary; sources wait here for one extra window
    /// before degrading into removals.
    pending_froms: Vec<PathBuf>,
    /// Sources that expired without ever seeing a destination — the
    /// destination event was likely lost (watch registered too late). After
    /// the batch is reconciled, these trigger a full location sweep so the
    /// move can be recovered.
    expired_froms: Vec<PathBuf>,
}

impl EventBatch {
    fn len(&self) -> usize {
        self.creates.len()
            + self.modifies.len()
            + self.removes.len()
            + self.rename_froms.len()
            + self.rename_tos.len()
    }

    fn absorb(&mut self, event: &notify::Event) {
        for (path, kind) in classify_event(event) {
            match kind {
                RawKind::Create => self.creates.push(path),
                RawKind::Modify => {
                    if !self.creates.contains(&path) && !self.modifies.contains(&path) {
                        self.modifies.push(path);
                    }
                }
                RawKind::Remove => {
                    // Create+remove in one window is transient churn; removal wins.
                    self.creates.retain(|p| *p != path);
                    self.modifies.retain(|p| *p != path);
                    self.removes.push(path);
                }
                RawKind::RenameFrom => self.rename_froms.push(path),
                RawKind::RenameTo => self.rename_tos.push(path),
            }
        }
    }

    /// Resolve the batch into ordered, deduplicated changes. Rename sources
    /// are paired with destinations across window boundaries (oldest first);
    /// a source that is still unpaired after two windows degrades to a
    /// removal, a destination without a source is a new file. Paths whose
    /// existence is ambiguous (created *and* removed in the same window) are
    /// settled by looking at the filesystem (fs truth).
    fn take(&mut self) -> Vec<PathChange> {
        let mut creates = std::mem::take(&mut self.creates);
        let mut modifies = std::mem::take(&mut self.modifies);
        let mut removes = std::mem::take(&mut self.removes);
        let mut carried = std::mem::take(&mut self.pending_froms);
        let mut rename_froms = std::mem::take(&mut self.rename_froms);
        let mut rename_tos = std::mem::take(&mut self.rename_tos);

        let mut changes: Vec<PathChange> = Vec::new();

        while let (Some(_), Some(to)) = (carried.first().cloned(), rename_tos.first().cloned()) {
            let from = carried.remove(0);
            rename_tos.remove(0);
            removes.retain(|p| *p != from);
            creates.retain(|p| *p != from);
            creates.retain(|p| *p != to);
            modifies.retain(|p| *p != to);
            changes.push(PathChange::Renamed { from, to });
        }

        while let (Some(from), Some(to)) =
            (rename_froms.first().cloned(), rename_tos.first().cloned())
        {
            rename_froms.remove(0);
            rename_tos.remove(0);
            removes.retain(|p| *p != from);
            creates.retain(|p| *p != from);
            creates.retain(|p| *p != to);
            modifies.retain(|p| *p != to);
            changes.push(PathChange::Renamed { from, to });
        }

        // Unpaired sources wait one extra window; ones that already waited are
        // removals (file left the watch or the destination event was lost).
        self.pending_froms.append(&mut rename_froms);
        for from in carried {
            self.expired_froms.push(from.clone());
            if !removes.contains(&from) {
                removes.push(from);
            }
        }
        for to in rename_tos {
            if !creates.contains(&to) {
                creates.push(to);
            }
        }

        let mut seen_removed: Vec<PathBuf> = Vec::new();
        let mut seen_created: Vec<PathBuf> = Vec::new();
        let mut seen_modified: Vec<PathBuf> = Vec::new();

        for path in removes {
            if seen_removed.contains(&path) {
                continue;
            }
            seen_removed.push(path.clone());
            // Create+remove still on disk means a replaced file (re-import); otherwise a removal.
            if path.exists() {
                changes.push(PathChange::Modified(path));
            } else {
                changes.push(PathChange::Removed(path));
            }
        }
        for path in creates {
            if seen_created.contains(&path) {
                continue;
            }
            seen_created.push(path.clone());
            if changes
                .iter()
                .any(|c| matches!(c, PathChange::Removed(p) if *p == path))
            {
                continue;
            }
            changes.push(PathChange::Created(path));
        }
        for path in modifies {
            if seen_modified.contains(&path)
                || seen_created.contains(&path)
                || seen_removed.contains(&path)
            {
                continue;
            }
            seen_modified.push(path.clone());
            changes.push(PathChange::Modified(path));
        }
        changes
    }
}

/// Map a raw `notify` event onto per-path raw kinds. Events the reconciler
/// can say nothing about (accesses, unknown kinds) are dropped.
fn classify_event(event: &notify::Event) -> Vec<(PathBuf, RawKind)> {
    use notify::event::{AccessKind, AccessMode, ModifyKind, RenameMode};
    let mut out = Vec::new();
    match &event.kind {
        notify::EventKind::Create(_) => {
            for path in &event.paths {
                out.push((path.clone(), RawKind::Create));
            }
        }
        notify::EventKind::Remove(_) => {
            for path in &event.paths {
                out.push((path.clone(), RawKind::Remove));
            }
        }
        notify::EventKind::Modify(kind) => match kind {
            ModifyKind::Name(RenameMode::From) => {
                if let Some(path) = event.paths.first() {
                    out.push((path.clone(), RawKind::RenameFrom));
                }
            }
            ModifyKind::Name(RenameMode::To) => {
                if let Some(path) = event.paths.first() {
                    out.push((path.clone(), RawKind::RenameTo));
                }
            }
            ModifyKind::Name(RenameMode::Both) => {
                if let [from, to, ..] = event.paths.as_slice() {
                    out.push((from.clone(), RawKind::RenameFrom));
                    out.push((to.clone(), RawKind::RenameTo));
                }
            }
            ModifyKind::Name(_) => {
                for path in &event.paths {
                    out.push((path.clone(), RawKind::Modify));
                }
            }
            ModifyKind::Data(_) | ModifyKind::Metadata(_) | ModifyKind::Any | ModifyKind::Other => {
                for path in &event.paths {
                    out.push((path.clone(), RawKind::Modify));
                }
            }
        },
        // The "writer finished" signal — treat as a content change.
        notify::EventKind::Access(AccessKind::Close(AccessMode::Write)) => {
            for path in &event.paths {
                out.push((path.clone(), RawKind::Modify));
            }
        }
        notify::EventKind::Access(_) | notify::EventKind::Other | notify::EventKind::Any => {}
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawKind {
    Create,
    Modify,
    Remove,
    RenameFrom,
    RenameTo,
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};

    fn event(kind: notify::EventKind, paths: &[&str]) -> notify::Event {
        let mut event = notify::Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        event
    }

    fn create(path: &str) -> notify::Event {
        event(notify::EventKind::Create(CreateKind::File), &[path])
    }

    fn modify(path: &str) -> notify::Event {
        event(
            notify::EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &[path],
        )
    }

    fn remove(path: &str) -> notify::Event {
        event(notify::EventKind::Remove(RemoveKind::File), &[path])
    }

    fn rename(from: &str, to: &str) -> notify::Event {
        event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[from, to],
        )
    }

    fn paths(changes: &[PathChange]) -> Vec<String> {
        changes
            .iter()
            .map(|change| match change {
                PathChange::Created(p) => format!("created:{}", p.display()),
                PathChange::Modified(p) => format!("modified:{}", p.display()),
                PathChange::Removed(p) => format!("removed:{}", p.display()),
                PathChange::Renamed { from, to } => {
                    format!("renamed:{}->{}", from.display(), to.display())
                }
            })
            .collect()
    }

    #[test]
    fn simple_kinds_are_classified() {
        let mut batch = EventBatch::default();
        batch.absorb(&create("/lib/a.epub"));
        batch.absorb(&modify("/lib/a.epub"));
        batch.absorb(&remove("/lib/b.pdf"));
        batch.absorb(&rename("/lib/x.epub", "/lib/y.epub"));

        assert_eq!(
            paths(&batch.take()),
            vec![
                "renamed:/lib/x.epub->/lib/y.epub",
                "removed:/lib/b.pdf",
                "created:/lib/a.epub",
            ]
        );
    }

    #[test]
    fn transient_create_remove_settles_by_fs_truth() {
        let tmp = tempfile::tempdir().unwrap();
        let transient = tmp.path().join("gone.epub");
        let kept = tmp.path().join("here.epub");
        std::fs::write(&kept, b"kept").unwrap();

        let mut batch = EventBatch::default();
        batch.absorb(&create(&transient.to_string_lossy()));
        batch.absorb(&remove(&transient.to_string_lossy()));
        batch.absorb(&create(&kept.to_string_lossy()));
        batch.absorb(&remove(&kept.to_string_lossy()));

        assert_eq!(
            paths(&batch.take()),
            vec![
                format!("removed:{}", transient.display()),
                format!("modified:{}", kept.display()),
            ]
        );
    }

    #[test]
    fn separate_from_to_events_pair_into_a_rename() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/lib/moved.epub"],
        ));
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            &["/lib/new.epub"],
        ));

        assert_eq!(
            paths(&batch.take()),
            vec!["renamed:/lib/moved.epub->/lib/new.epub"]
        );
    }

    #[test]
    fn from_without_to_degrades_to_removal() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/lib/moved.epub"],
        ));

        assert!(batch.take().is_empty(), "source waits one extra window");
        assert_eq!(paths(&batch.take()), vec!["removed:/lib/moved.epub"]);
    }

    #[test]
    fn duplicate_events_collapse_into_one_change() {
        let mut batch = EventBatch::default();
        for _ in 0..10 {
            batch.absorb(&create("/lib/a.epub"));
            batch.absorb(&modify("/lib/a.epub"));
        }

        assert_eq!(paths(&batch.take()), vec!["created:/lib/a.epub"]);
    }

    #[test]
    fn rename_pair_absorbs_duplicate_create_of_destination() {
        let mut batch = EventBatch::default();
        batch.absorb(&create("/lib/incoming.epub"));
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/lib/other.epub"],
        ));
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            &["/lib/incoming.epub"],
        ));

        assert_eq!(
            paths(&batch.take()),
            vec!["renamed:/lib/other.epub->/lib/incoming.epub"]
        );
    }

    #[test]
    fn close_write_is_a_modification() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Access(notify::event::AccessKind::Close(
                notify::event::AccessMode::Write,
            )),
            &["/lib/done.epub"],
        ));
        assert_eq!(paths(&batch.take()), vec!["modified:/lib/done.epub"]);
    }

    #[test]
    fn access_and_unknown_events_are_ignored() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Access(notify::event::AccessKind::Open(
                notify::event::AccessMode::Read,
            )),
            &["/lib/a.epub"],
        ));
        batch.absorb(&notify::Event::new(notify::EventKind::Other));
        assert!(batch.take().is_empty());
    }

    #[test]
    fn rename_straddling_windows_pairs_across_flushes() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/lib/moved.epub"],
        ));

        let first = batch.take();
        assert_eq!(
            paths(&first),
            Vec::<String>::new(),
            "an unpaired source must not resolve yet"
        );

        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            &["/lib/new.epub"],
        ));
        assert_eq!(
            paths(&batch.take()),
            vec!["renamed:/lib/moved.epub->/lib/new.epub"]
        );
    }

    #[test]
    fn stale_rename_source_degrades_after_a_second_window() {
        let mut batch = EventBatch::default();
        batch.absorb(&event(
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/lib/gone.epub"],
        ));
        assert!(batch.take().is_empty());

        assert_eq!(paths(&batch.take()), vec!["removed:/lib/gone.epub"]);
        assert!(batch.take().is_empty());
    }

    #[test]
    fn rename_pair_beats_separate_remove_noise() {
        let mut batch = EventBatch::default();
        batch.absorb(&rename("/lib/a.epub", "/lib/sub/a.epub"));
        batch.absorb(&remove("/lib/a.epub"));

        assert_eq!(
            paths(&batch.take()),
            vec!["renamed:/lib/a.epub->/lib/sub/a.epub"]
        );
    }
}
