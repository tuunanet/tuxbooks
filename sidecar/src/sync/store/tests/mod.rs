//! Store tests, split along the production modules.

use serde_json::Value;

use super::super::model::{EntityKind, Hlc, Op, OP_SCHEMA};
use super::*;

mod covers;
mod op_io;
mod root;
mod validate;

fn op(kind: EntityKind, fields: Value) -> Op {
    Op {
        schema: OP_SCHEMA,
        op_id: "a".repeat(32),
        device_id: "b".repeat(32),
        hlc: Hlc {
            wall: 1,
            counter: 0,
            device: "b".repeat(32),
        },
        kind,
        entity_uid: "e".repeat(32),
        book_uid: Some("e".repeat(32)),
        deleted: false,
        restore: false,
        fields: fields_object(fields).unwrap(),
        prior: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
    }
}
