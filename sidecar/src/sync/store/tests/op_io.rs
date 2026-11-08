//! Op read/write/scan tests.

use std::fs;

use serde_json::json;

use super::*;
use crate::sync::model::MAX_OP_FILE_BYTES;

#[test]
fn writes_and_reads_an_op() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let op = op(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "cfi": "x"}),
    );
    let relative = write_op(&root, &op).unwrap();
    let read = read_op(&root.join(relative)).unwrap();
    assert_eq!(read.op_id, op.op_id);
    assert_eq!(read.kind, EntityKind::Annotation);
}

#[test]
fn scan_ops_ignores_non_operation_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    assert!(scan_ops(&root).unwrap().is_empty());

    let op = op(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "cfi": "x"}),
    );
    let relative = write_op(&root, &op).unwrap();
    let device_dir = root.join("ops").join(&op.device_id);
    fs::write(device_dir.join("notes.txt"), b"not an op").unwrap();
    fs::write(device_dir.join(".hidden.json"), b"{}").unwrap();
    fs::create_dir_all(device_dir.join("nested.json")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let non_utf8 = std::ffi::OsString::from_vec(b"bad\xff.json".to_vec());
        fs::write(device_dir.join(non_utf8), b"{}").unwrap();
    }

    let files = scan_ops(&root).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].relative_path, relative);
    assert!(files[0].size > 0);
}

#[test]
fn read_op_rejects_oversized_malformed_and_invalid_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();

    assert!(read_op(&root.join("missing.json"))
        .unwrap_err()
        .contains("cannot stat"));

    let oversized = root.join("oversized.json");
    fs::write(&oversized, vec![b' '; MAX_OP_FILE_BYTES as usize + 1]).unwrap();
    assert!(read_op(&oversized)
        .unwrap_err()
        .contains("over the 1 MiB limit"));

    let malformed = root.join("malformed.json");
    fs::write(&malformed, b"{not json").unwrap();
    assert!(read_op(&malformed).unwrap_err().contains("invalid JSON"));

    let mut invalid = op(EntityKind::Annotation, json!({"kind": "bookmark"}));
    invalid.op_id = "short".into();
    let invalid_path = root.join("invalid.json");
    fs::write(&invalid_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(read_op(&invalid_path).unwrap_err().contains("op_id"));
}

#[test]
fn write_op_rejects_operations_over_the_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let root = resolve_root(tmp.path()).unwrap();
    let oversized = op(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "note": "x".repeat(1_100_000)}),
    );
    let err = write_op(&root, &oversized).unwrap_err();
    assert!(err.to_string().contains("1 MiB"), "{err}");
}
