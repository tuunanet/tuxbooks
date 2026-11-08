//! Root resolution, connect, and archive tests.

use std::fs;
use std::path::Path;

use serde_json::json;

use super::*;

#[test]
fn archiving_a_folder_without_a_library_returns_none() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    assert!(archive_existing_library(&folder, "2026-10-29T15:01:00Z")
        .unwrap()
        .is_none());
}

#[test]
fn root_adds_tuxbooks_child_once() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    assert_eq!(root.file_name().unwrap(), SYNC_DIR_NAME);
    let again = resolve_root(&root).unwrap();
    assert_eq!(again, root);
}

#[test]
fn connect_reports_whether_it_created_the_library() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();

    let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
    assert!(!first.existed, "the first connect creates the library");

    let second = connect(&folder, "device", "Laptop", "2026-10-29T15:00:01Z").unwrap();
    assert!(second.existed, "the second connect finds the same library");
    assert_eq!(first.library.library_id, second.library.library_id);
}

#[test]
fn archive_moves_an_existing_library_aside_and_keeps_its_files() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
    let old_id = first.library.library_id.clone();

    let archived = archive_existing_library(&folder, "2026-10-29T15:01:00Z")
        .unwrap()
        .expect("an existing library was archived");
    assert!(archived.join(LIBRARY_FILE).exists());
    assert!(archived
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("TuxBooks.before-"));

    let next = connect(&folder, "device", "Laptop", "2026-10-29T15:01:01Z").unwrap();
    assert!(!next.existed);
    assert_ne!(next.library.library_id, old_id);
}

#[test]
fn archiving_a_folder_named_tuxbooks_recreates_the_chosen_path() {
    let tmp = tempfile::tempdir().unwrap();
    let chosen = tmp.path().join("TuxBooks");
    fs::create_dir_all(&chosen).unwrap();
    connect(&chosen, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
    let old_id = connect(&chosen, "device", "Laptop", "2026-10-29T15:00:01Z")
        .unwrap()
        .library
        .library_id;

    let archived = archive_existing_library(&chosen, "2026-10-29T15:02:00Z")
        .unwrap()
        .expect("library archived");
    assert!(
        chosen.is_dir(),
        "the chosen path is ready for a new library"
    );
    let next = connect(&chosen, "device", "Laptop", "2026-10-29T15:02:01Z").unwrap();
    assert!(!next.existed);
    assert_ne!(next.library.library_id, old_id);
    assert!(archived.join(LIBRARY_FILE).exists());
}

#[test]
fn resolve_root_rejects_relative_and_missing_paths() {
    assert!(resolve_root(Path::new("relative/path")).is_err());
    let tmp = tempfile::tempdir().unwrap();
    assert!(resolve_root(&tmp.path().join("missing")).is_err());
}

#[test]
fn library_schema_is_bounded_and_requires_a_regular_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();

    assert!(library_schema(Path::new("relative/path")).is_none());
    assert!(library_schema(&tmp.path().join("missing")).is_none());
    assert!(library_schema(&folder).is_none(), "no marker yet");

    let root = resolve_root(&folder).unwrap();
    write_json_atomic(
        &root.join(LIBRARY_FILE),
        &json!({
            "schema": OP_SCHEMA,
            "library_id": "a".repeat(32),
            "created_at": "2026-10-29T00:00:00.000Z",
        }),
    )
    .unwrap();
    assert_eq!(library_schema(&folder), Some(OP_SCHEMA));
    // A folder already named TuxBooks is its own root.
    assert_eq!(library_schema(&root), Some(OP_SCHEMA));

    fs::write(root.join(LIBRARY_FILE), b"{not json").unwrap();
    assert!(library_schema(&folder).is_none(), "invalid JSON");

    fs::write(
        root.join(LIBRARY_FILE),
        vec![b' '; MAX_LIBRARY_MARKER_BYTES as usize + 1],
    )
    .unwrap();
    assert!(library_schema(&folder).is_none(), "oversized");

    fs::remove_file(root.join(LIBRARY_FILE)).unwrap();
    fs::create_dir(root.join(LIBRARY_FILE)).unwrap();
    assert!(library_schema(&folder).is_none(), "not a regular file");
}

#[test]
fn connect_rejects_newer_schemas_and_invalid_library_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let root = resolve_root(&folder).unwrap();
    write_json_atomic(
        &root.join(LIBRARY_FILE),
        &json!({
            "schema": OP_SCHEMA + 1,
            "library_id": "a".repeat(32),
            "created_at": "2026-10-29T00:00:00.000Z",
        }),
    )
    .unwrap();
    let newer = connect(&folder, "device", "Laptop", "now").unwrap_err();
    assert!(newer.to_string().contains("schema"), "{newer}");

    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let root = resolve_root(&folder).unwrap();
    write_json_atomic(
        &root.join(LIBRARY_FILE),
        &json!({
            "schema": OP_SCHEMA,
            "library_id": "not-a-library-id",
            "created_at": "2026-10-29T00:00:00.000Z",
        }),
    )
    .unwrap();
    let invalid = connect(&folder, "device", "Laptop", "now").unwrap_err();
    assert!(
        invalid.to_string().contains("invalid library id"),
        "{invalid}"
    );
}

#[test]
fn connect_updates_a_renamed_device_and_rejects_a_foreign_device_file() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    let first = connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();
    let second = connect(&folder, "device", "Desktop", "2026-10-29T15:00:01Z").unwrap();
    assert_eq!(second.device.name, "Desktop");
    assert_eq!(first.library.library_id, second.library.library_id);

    let device_path = second.root.join("devices/device/device.json");
    let mut foreign: DeviceFile = super::super::io::read_json(&device_path).unwrap();
    foreign.device_id = "another-device".into();
    write_json_atomic(&device_path, &foreign).unwrap();
    let err = connect(&folder, "device", "Desktop", "2026-10-29T15:00:02Z").unwrap_err();
    assert!(err.to_string().contains("does not match"), "{err}");
}

#[test]
fn archive_uses_a_suffixed_name_when_the_first_target_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("sync");
    fs::create_dir_all(&folder).unwrap();
    connect(&folder, "device", "Laptop", "2026-10-29T15:00:00Z").unwrap();

    let stamp = "2026-10-29T15:01:00Z";
    let first_target = folder.join("TuxBooks.before-20261029T150100Z");
    fs::create_dir_all(&first_target).unwrap();

    let archived = archive_existing_library(&folder, stamp).unwrap().unwrap();
    assert_eq!(archived, folder.join("TuxBooks.before-20261029T150100Z-1"));
    assert!(archived.join(LIBRARY_FILE).exists());
}
