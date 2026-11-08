//! Op grammar tests: envelopes, field types and ranges, fields object.

use serde_json::{json, Value};

use super::*;
use crate::sync::model::{
    EntityKind, MAX_COLLECTION_NAME_BYTES, MAX_FIELD_STRING_BYTES, MAX_LIST_ITEMS,
};

#[test]
fn valid_annotation_op_passes() {
    validate_op(&op(
        EntityKind::Annotation,
        json!({"kind": "highlight", "text": "passage", "note": null}),
    ))
    .unwrap();
}

#[test]
fn rejects_unknown_fields_and_bad_types() {
    assert!(validate_op(&op(
        EntityKind::Annotation,
        json!({"kind": "highlight", "evil": "x"})
    ))
    .is_err());
    assert!(validate_op(&op(
        EntityKind::Annotation,
        json!({"kind": "highlight", "page_number": 0})
    ))
    .is_err());
    assert!(validate_op(&op(EntityKind::Membership, json!({"present": "yes"}))).is_err());
    assert!(validate_op(&op(
        EntityKind::BookIdentity,
        json!({"content_hash": "a".repeat(64), "evil": "x"})
    ))
    .is_err());
    assert!(validate_op(&op(
        EntityKind::Book,
        json!({"snapshot": null, "evil": "x"})
    ))
    .is_err());
}

fn assert_op_rejected(op: &Op, because: &str) {
    assert!(validate_op(op).is_err(), "expected rejection for {because}");
}

fn assert_field_rejected(kind: EntityKind, fields: Value) {
    assert!(
        validate_op(&op(kind, fields)).is_err(),
        "expected {kind:?} fields to be rejected"
    );
}

fn assert_field_accepted(kind: EntityKind, fields: Value) {
    validate_op(&op(kind, fields)).unwrap();
}

#[test]
fn validate_op_rejects_malformed_envelopes() {
    let base = op(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "cfi": "x"}),
    );

    let mut bad = base.clone();
    bad.schema = OP_SCHEMA + 1;
    assert_op_rejected(&bad, "a newer schema");

    let mut bad = base.clone();
    bad.op_id = "short".into();
    assert_op_rejected(&bad, "a malformed op id");

    let mut bad = base.clone();
    bad.device_id = "short".into();
    assert_op_rejected(&bad, "a malformed device id");

    let mut bad = base.clone();
    bad.hlc.device = "c".repeat(32);
    assert_op_rejected(&bad, "an hlc device that differs from the device id");

    let mut bad = base.clone();
    bad.hlc.wall = -1;
    assert_op_rejected(&bad, "a negative hlc wall");

    let mut bad = base.clone();
    bad.entity_uid = "../escape".into();
    assert_op_rejected(&bad, "an unsafe entity uid");

    let mut bad = base.clone();
    bad.book_uid = Some("../escape".into());
    assert_op_rejected(&bad, "an unsafe book uid");

    let mut bad = base.clone();
    bad.deleted = true;
    assert_op_rejected(&bad, "a delete that carries fields");

    let mut bad = base.clone();
    bad.fields.clear();
    bad.deleted = true;
    bad.restore = true;
    assert_op_rejected(&bad, "a restore that is also a delete");

    let mut bad = op(
        EntityKind::BookIdentity,
        json!({"content_hash": "a".repeat(64)}),
    );
    bad.deleted = true;
    bad.fields.clear();
    assert_op_rejected(&bad, "a book identity delete");

    let mut bad = op(
        EntityKind::BookIdentity,
        json!({"content_hash": "a".repeat(64)}),
    );
    bad.book_uid = Some("f".repeat(32));
    assert_op_rejected(&bad, "a book identity whose uid differs");

    let mut bad = op(EntityKind::Book, json!({"snapshot": "{}"}));
    bad.book_uid = Some("f".repeat(32));
    assert_op_rejected(&bad, "a book whose uid differs");

    let mut bad = op(EntityKind::Progress, json!({"progress_percent": 1.0}));
    bad.book_uid = None;
    assert_op_rejected(&bad, "a book-scoped progress op without a book");

    let mut bad = op(EntityKind::Metadata, json!({"title": "Book"}));
    bad.book_uid = None;
    assert_op_rejected(&bad, "a book-scoped metadata op without a book");

    let mut bad = base.clone();
    bad.prior = json!({"evil": "x"}).as_object().cloned();
    assert_op_rejected(&bad, "an unknown prior field");

    let mut bad = base.clone();
    bad.prior = json!({"page_number": 0}).as_object().cloned();
    assert_op_rejected(&bad, "an invalid prior value");

    let mut membership = op(EntityKind::Membership, json!({"present": true}));
    membership.entity_uid = "collection-only".into();
    assert_op_rejected(&membership, "a membership uid without a book part");

    let mut collection = op(EntityKind::Collection, json!({"name": "Shelf"}));
    collection.book_uid = None;
    validate_op(&collection).unwrap();

    let mut identity = op(
        EntityKind::BookIdentity,
        json!({"content_hash": "a".repeat(64)}),
    );
    identity.book_uid = Some(identity.entity_uid.clone());
    validate_op(&identity).unwrap();
}

#[test]
fn validate_field_values_rejects_bad_types_and_ranges() {
    assert_field_rejected(EntityKind::Annotation, json!({"kind": "note"}));
    assert_field_rejected(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "page_number": 0}),
    );
    assert_field_rejected(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "page_fraction": 1.5}),
    );
    assert_field_rejected(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "text": "x".repeat(MAX_FIELD_STRING_BYTES + 1)}),
    );
    assert_field_rejected(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "text": 5}),
    );
    assert_field_accepted(
        EntityKind::Annotation,
        json!({"kind": "bookmark", "page_fraction": 0.5, "text": null}),
    );

    assert_field_rejected(EntityKind::Progress, json!({"progress_percent": 101.0}));
    assert_field_rejected(EntityKind::Progress, json!({"progress_percent": "x"}));
    assert_field_rejected(EntityKind::Progress, json!({"progression": -0.1}));
    assert_field_rejected(EntityKind::Progress, json!({"character_offset": -1}));
    assert_field_rejected(EntityKind::Progress, json!({"character_offset": "x"}));
    assert_field_rejected(EntityKind::Progress, json!({"page_number": 0}));
    assert_field_rejected(EntityKind::Progress, json!({"scroll_offset": "x"}));
    assert_field_rejected(EntityKind::Progress, json!({"schema_version": -1}));
    assert_field_accepted(
        EntityKind::Progress,
        json!({"progress_percent": 50.0, "progression": 1.0, "character_offset": 0}),
    );

    assert_field_rejected(EntityKind::Metadata, json!({"series_index": "x"}));
    assert_field_rejected(EntityKind::Metadata, json!({"authors_customized": "yes"}));
    assert_field_rejected(EntityKind::Metadata, json!({"authors": "not-an-array"}));
    assert_field_rejected(EntityKind::Metadata, json!({"authors": [1]}));
    assert_field_rejected(
        EntityKind::Metadata,
        json!({"authors": vec!["x"; MAX_LIST_ITEMS + 1]}),
    );
    assert_field_rejected(EntityKind::Metadata, json!({"authors": ["x".repeat(1025)]}));
    assert_field_accepted(
        EntityKind::Metadata,
        json!({"authors": ["Alice"], "subjects": ["Essays"], "series_index": 1.5}),
    );

    assert_field_rejected(EntityKind::Collection, json!({"name": ""}));
    assert_field_rejected(EntityKind::Collection, json!({"name": "   "}));
    assert_field_rejected(
        EntityKind::Collection,
        json!({"name": "x".repeat(MAX_COLLECTION_NAME_BYTES + 1)}),
    );
    assert_field_rejected(EntityKind::Collection, json!({"name": 5}));

    assert_field_rejected(EntityKind::Membership, json!({"present": "yes"}));
    assert_field_rejected(EntityKind::Membership, json!({"added_at": 5}));
    assert_field_rejected(EntityKind::Opened, json!({"last_opened_at": 5}));

    assert_field_rejected(EntityKind::BookIdentity, json!({"content_hash": "short"}));
    assert_field_rejected(EntityKind::BookIdentity, json!({"unknown": "x"}));

    assert_field_rejected(EntityKind::Book, json!({"snapshot": 5}));
    assert_field_rejected(
        EntityKind::Book,
        json!({"replacement_book_uid": "../escape"}),
    );
    assert_field_rejected(EntityKind::Book, json!({"discarded": "yes"}));
    assert_field_rejected(EntityKind::Book, json!({"unknown": "x"}));

    assert_field_rejected(EntityKind::FileVersion, json!({"content_hash": "short"}));
    assert_field_rejected(EntityKind::FileVersion, json!({"size": -1}));
    assert_field_rejected(EntityKind::FileVersion, json!({"size": "big"}));
    assert_field_rejected(EntityKind::FileVersion, json!({"unknown": "x"}));
}

/// The file_version grammar (ADR 0018 D1): one hash-and-size pair, book
/// scoped, never a delete.
#[test]
fn file_version_ops_carry_one_hash_size_pair_and_never_delete() {
    let hash = "a".repeat(64);
    validate_op(&op(
        EntityKind::FileVersion,
        json!({"content_hash": hash, "size": 12345}),
    ))
    .unwrap();

    // Book-scoped: the envelope requires book_uid (already covered by the
    // generic check), and a delete is never valid for this kind.
    let mut deleted = op(EntityKind::FileVersion, json!({}));
    deleted.deleted = true;
    assert!(validate_op(&deleted).is_err());
}

#[test]
fn fields_object_requires_an_object() {
    assert!(fields_object(json!({"note": "x"})).is_ok());
    assert!(fields_object(json!(["not", "an", "object"])).is_err());
    assert!(fields_object(Value::Null).is_err());
}
