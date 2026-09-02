//! Opt-in tests for the extended (real-world) and conformance (W3C) EPUB
//! corpora, fetched by `just fetch-epub-extended` into the ignored cache
//! directory `.build/fixtures/epub/`.
//!
//! These tests SKIP with a notice when the corpus is absent, so `just test`,
//! `just check`, CI, and fresh clones stay green without any download. Run
//! them explicitly:
//!
//!     just test-epub-extended     # Tier B: real-world books
//!     just test-epub-conformance  # Tier C: W3C standards corpus
//!
//! `EXTENDED_EPUB_ROOT` / `CONFORMANCE_EPUB_ROOT` override the locations.

use std::path::{Path, PathBuf};

use tuxbooks_lib::epub::parse_epub;

fn corpus_dir(tier: &str) -> Option<PathBuf> {
    let env_key = format!("{}_EPUB_ROOT", tier.to_uppercase());
    let from_env = std::env::var(&env_key)
        .ok()
        .filter(|value| !value.is_empty());
    let path = from_env.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../.build/fixtures/epub/{tier}"))
    });
    path.is_dir().then_some(path)
}

/// Every .epub under the tier root, recursive (datasets may unpack nested).
fn epub_files(root: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"))
        })
        .collect();
    paths.sort();
    paths
}

fn exercise_corpus(tier: &str) {
    let default_root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../.build/fixtures/epub/{tier}"));
    let Some(root) = corpus_dir(tier) else {
        eprintln!(
            "skipping {tier} corpus tests: no dataset at {} — fetch one with \
             `just fetch-epub-extended` (opt-in; the default suite never \
             downloads it)",
            default_root.display()
        );
        return;
    };

    let files = epub_files(&root);
    assert!(
        !files.is_empty(),
        "{tier} corpus at {} contains no .epub files — the dataset fetch or \
         extraction is broken",
        root.display()
    );

    let mut failures = Vec::new();
    for path in &files {
        match parse_epub(path) {
            Ok(book) => {
                if book.metadata.title.is_empty() {
                    failures.push(format!("{}: parsed with an empty title", path.display()));
                }
            }
            Err(err) => failures.push(format!("{}: {err:?}", path.display())),
        }
    }
    assert!(
        failures.is_empty(),
        "{tier} corpus: {} of {} publications failed to parse:\n  {}",
        failures.len(),
        files.len(),
        failures.join("\n  ")
    );
    eprintln!("{tier} corpus: {} publications parsed", files.len());
}

mod extended {
    use super::exercise_corpus;

    #[test]
    fn extended_corpus_imports_every_book() {
        exercise_corpus("extended");
    }
}

mod conformance {
    use super::exercise_corpus;

    #[test]
    fn conformance_corpus_imports_every_book() {
        exercise_corpus("conformance");
    }
}
