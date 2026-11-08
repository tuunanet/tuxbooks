//! The sync-folder watcher (ADR 0018 D5): wakes the engine when remote
//! operation or blob files land in the sync folder, so a remote change is
//! seen at provider latency plus one quiet period instead of up to the 10 s
//! pass interval. The watcher adds no scheduling of its own — passes still
//! run in the engine loop, and the loop tolerates an extra wake — the
//! watcher only removes the idle wait.
//!
//! The shape mirrors the library watcher
//! (`services/library_watcher.rs`): one recommended notify watcher feeding
//! a single thread that debounces events with a quiet period. The thread
//! holds only the engine's wake channel, never the service, so it cannot
//! keep the engine alive past shutdown.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use notify::Watcher;
use tokio::sync::Notify;

use crate::error::AppError;

use super::SyncService;

/// Quiet period after the last matching event before the engine is woken.
/// Two seconds — deliberately longer than the library watcher's 600 ms
/// production debounce (`lib.rs`), because this folder does a different
/// job: it receives remote cloud deliveries as multi-second bursts, not
/// local edits, and a client that writes straight to the final file name
/// (no temp-plus-rename) can be mid-write when a pass starts, and reading
/// that half-written op would surface a spurious sync issue. The window
/// lets a delivery finish before the wake (ADR 0018 D5's "quiet-period
/// debounce of a few seconds"). Bursts still collapse into the single wake
/// that follows the quiet period, and an early wake only starts a pass
/// sooner.
const QUIET_PERIOD: Duration = Duration::from_millis(2_000);

/// Matching events beyond this flush immediately instead of waiting out the
/// quiet period, so a steady stream of arrivals (a cloud client delivering
/// a large batch) cannot postpone a wake forever. Same bound and reason as
/// the library watcher's flush limit.
const FORCE_FLUSH_LIMIT: usize = 512;

/// Handle to the running sync-folder watcher. Dropping it stops event
/// delivery and joins the debounce thread — the same shutdown discipline as
/// the engine's own loop task.
pub(super) struct SyncFolderWatcher {
    inner: Option<WatcherHandle>,
}

/// The notify watcher plus the debounce thread that drains its events.
struct WatcherHandle {
    watcher: notify::RecommendedWatcher,
    thread: std::thread::JoinHandle<()>,
}

/// What the watcher needs: the folder root to watch, the quiet period, and
/// the engine's wake channel.
struct SyncWatcherConfig {
    root: PathBuf,
    quiet_period: Duration,
    wake: Arc<Notify>,
}

impl SyncFolderWatcher {
    /// Start watching `root` recursively. Returns after the watch is
    /// registered, so a file dropped right after cannot be missed — the
    /// same startup guarantee the library watcher gives.
    fn start(config: SyncWatcherConfig) -> Result<Self, AppError> {
        let (event_tx, event_rx) = channel();
        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                // A closed receiver just means the watcher is shutting down.
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            })
            .map_err(watcher_error)?;
        watcher
            .watch(&config.root, notify::RecursiveMode::Recursive)
            .map_err(watcher_error)?;
        let thread = std::thread::Builder::new()
            .name("sync-watcher".into())
            .spawn(move || run_wake_loop(event_rx, config.root, config.quiet_period, config.wake))
            .map_err(|err| AppError::Io(std::io::Error::other(err.to_string())))?;
        Ok(Self {
            inner: Some(WatcherHandle { watcher, thread }),
        })
    }
}

impl Drop for SyncFolderWatcher {
    fn drop(&mut self) {
        // Drop the notify watcher first: it owns the event sender, so its
        // drop disconnects the channel and the debounce thread returns.
        // The join then guarantees the thread is gone before the engine is
        // — no leaked task, no wake racing the service's teardown.
        if let Some(handle) = self.inner.take() {
            drop(handle.watcher);
            let _ = handle.thread.join();
        }
    }
}

fn watcher_error(err: notify::Error) -> AppError {
    AppError::Io(std::io::Error::other(err.to_string()))
}

fn run_wake_loop(
    events: Receiver<notify::Event>,
    root: PathBuf,
    quiet_period: Duration,
    wake: Arc<Notify>,
) {
    let mut gate = WakeGate::default();
    loop {
        match events.recv_timeout(quiet_period) {
            Ok(event) => {
                // The backend lost events (kernel queue overflow) and asks
                // for a rescan: the next pass reconciles against the folder,
                // so one wake is the right response.
                let rescan = event.flag() == Some(notify::event::Flag::Rescan);
                let matched = rescan || event.paths.iter().any(|path| wakes_engine(&root, path));
                if gate.absorb(matched) {
                    wake.notify_one();
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if gate.quiet_elapsed() {
                    wake.notify_one();
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Whether the quiet period owes the engine a wake. Matching events mark it
/// during a window; when the window closes with no further event, exactly
/// one wake flushes — a burst of any size collapses into that one wake.
#[derive(Default)]
struct WakeGate {
    pending: bool,
    queued: usize,
}

impl WakeGate {
    /// Absorb one event; `matched` says whether any of its paths is an op
    /// or blob. Returns true when the queue hit the force-flush bound and
    /// the wake must happen now.
    fn absorb(&mut self, matched: bool) -> bool {
        if !matched {
            return false;
        }
        self.pending = true;
        self.queued += 1;
        if self.queued >= FORCE_FLUSH_LIMIT {
            self.pending = false;
            self.queued = 0;
            return true;
        }
        false
    }

    /// The quiet period elapsed with no event: a pending wake is due, and
    /// the gate re-arms for the next burst.
    fn quiet_elapsed(&mut self) -> bool {
        let due = std::mem::take(&mut self.pending);
        if due {
            self.queued = 0;
        }
        due
    }
}

/// True when a path under the sync root is a file the engine consumes: an
/// operation (`ops/<device>/<op>.json`) or a content blob (`blobs/**`,
/// covers and books alike). Everything else — the library and device
/// markers, write probes, cloud-client temp and chunk files — must not
/// wake the engine, or a busy folder would wake-storm it past the point of
/// the 10 s pass interval the watcher exists to improve.
///
/// The op rule mirrors `store::scan_ops` — the same flat-read rule: plain
/// `*.json` names, no dot-prefixed temps. Any device directory passes here
/// (scan_ops never validated the directory name; the pass's own grammar
/// does). The blob rule stays local and permissive on purpose — the store
/// re-validates every name it reads, so the watcher only decides whether a
/// pass is worth running, and a hidden dotfile is noise under the same
/// convention scan_ops already applies.
///
/// Shared-helper extraction is deferred to the planned store.rs split task (push gate).
fn wakes_engine(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(Component::Normal(top)) = components.next() else {
        return false; // the root itself, or a non-plain component
    };
    match top.to_str() {
        Some("ops") => match (components.next(), components.next()) {
            (Some(Component::Normal(_device)), Some(Component::Normal(name)))
                if components.next().is_none() =>
            {
                is_op_file_name(name)
            }
            _ => false,
        },
        Some("blobs") => {
            let mut last: Option<&OsStr> = None;
            for component in components {
                let Component::Normal(name) = component else {
                    return false;
                };
                last = Some(name);
            }
            last.is_some_and(|name| !is_hidden(name))
        }
        _ => false,
    }
}

/// The operation file-name rule from `store::scan_ops`: `.json`, and not a
/// dot-prefixed temp name.
fn is_op_file_name(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.ends_with(".json") && !name.starts_with('.'))
}

fn is_hidden(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| name.starts_with('.'))
}

impl SyncService {
    /// (Re)start the folder watcher against the current sync root. Called
    /// when the engine starts and when a folder connects — the two moments
    /// the root becomes known or changes (ADR 0018 D5). With no usable root
    /// there is nothing to watch, and any previous watcher stops.
    pub(super) fn restart_watcher(&self) {
        let mut slot = self
            .inner
            .watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Stop the previous watcher first: a root change starts a fresh
        // watch, and two debounce threads would only double-wake.
        drop(slot.take());
        let Some(root) = self.sync_root() else {
            return;
        };
        match SyncFolderWatcher::start(SyncWatcherConfig {
            root,
            quiet_period: QUIET_PERIOD,
            wake: Arc::clone(&self.inner.wake),
        }) {
            Ok(handle) => *slot = Some(handle),
            Err(err) => eprintln!("sync watcher: cannot start: {err}"),
        }
    }

    /// Stop the watcher. Dropping the handle joins the debounce thread, so
    /// nothing survives the engine's shutdown.
    pub(super) fn stop_watcher(&self) {
        let mut slot = self
            .inner
            .watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        drop(slot.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/cloud/TuxBooks";

    #[test]
    fn operation_files_wake_the_engine() {
        let root = Path::new(ROOT);
        let device = "0123456789abcdef0123456789abcdef";
        assert!(wakes_engine(
            root,
            &root.join("ops").join(device).join("9.json")
        ));
        // scan_ops tolerates any device directory name; so does the filter.
        assert!(wakes_engine(root, &root.join("ops/any-device/op.json")));
    }

    #[test]
    fn temp_and_stray_op_paths_do_not_wake() {
        let root = Path::new(ROOT);
        assert!(!wakes_engine(root, &root.join("ops/dev/.op.json.tmp")));
        assert!(!wakes_engine(root, &root.join("ops/dev/.partial.json")));
        assert!(!wakes_engine(root, &root.join("ops/dev/note.txt")));
        assert!(!wakes_engine(root, &root.join("ops/dev/nested/op.json")));
        assert!(!wakes_engine(root, &root.join("ops/dev")));
        assert!(!wakes_engine(root, &root.join("ops")));
    }

    #[test]
    fn blob_files_wake_the_engine() {
        let root = Path::new(ROOT);
        let cover = format!("{}.png", "a".repeat(16));
        assert!(wakes_engine(root, &root.join("blobs/covers").join(cover)));
        let book = format!("{}.epub", "b".repeat(64));
        assert!(wakes_engine(root, &root.join("blobs/books").join(book)));
    }

    #[test]
    fn folder_noise_does_not_wake_the_engine() {
        let root = Path::new(ROOT);
        assert!(!wakes_engine(root, &root.join("library.json")));
        assert!(!wakes_engine(root, &root.join("devices/abc/device.json")));
        assert!(!wakes_engine(root, &root.join(".tuxbooks-write-1.tmp")));
        assert!(!wakes_engine(root, &root.join("unrelated/chapter.epub")));
        assert!(!wakes_engine(root, &root.join("blobs")));
        assert!(!wakes_engine(root, &root.join("blobs/.arriving.part")));
        assert!(!wakes_engine(root, Path::new("/elsewhere/ops/dev/op.json")));
        assert!(!wakes_engine(root, root));
    }

    #[test]
    fn a_burst_of_matches_collapses_into_one_wake() {
        let mut gate = WakeGate::default();
        for _ in 0..50 {
            assert!(!gate.absorb(true));
            assert!(!gate.absorb(false), "noise never marks the gate");
        }
        assert!(gate.quiet_elapsed(), "the whole burst is one pending wake");
        assert!(!gate.quiet_elapsed(), "and only one");
    }

    #[test]
    fn pure_noise_never_wakes_the_gate() {
        let mut gate = WakeGate::default();
        for _ in 0..100 {
            gate.absorb(false);
        }
        assert!(!gate.quiet_elapsed());
    }

    #[test]
    fn a_stream_that_never_quiets_flushes_at_the_force_limit() {
        let mut gate = WakeGate::default();
        let mut flushed = false;
        for _ in 0..FORCE_FLUSH_LIMIT {
            flushed |= gate.absorb(true);
        }
        assert!(flushed, "the wake cannot be postponed forever");
        assert!(
            !gate.quiet_elapsed(),
            "the flush was the wake; nothing pending"
        );
    }

    #[test]
    fn the_gate_re_arms_after_a_flush() {
        let mut gate = WakeGate::default();
        for _ in 0..FORCE_FLUSH_LIMIT {
            gate.absorb(true);
        }
        assert!(!gate.absorb(true), "a fresh burst starts a fresh window");
        assert!(gate.quiet_elapsed());
    }
}
