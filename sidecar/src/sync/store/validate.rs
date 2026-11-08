//! Op envelope and field validation. This is the grammar every op must
//! satisfy before it is written to disk or applied from a remote file.

use serde_json::{Map, Value};

use crate::sync::model::{
    field_names, is_hex_hash, is_hex_id, is_safe_uid, EntityKind, Op, MAX_COLLECTION_NAME_BYTES,
    MAX_FIELD_STRING_BYTES, MAX_LIST_ITEMS, OP_SCHEMA,
};

pub fn validate_op(op: &Op) -> Result<(), String> {
    if op.schema != OP_SCHEMA {
        return Err(format!("unsupported operation schema {}", op.schema));
    }
    if !is_hex_id(&op.op_id) {
        return Err("op_id must be 32 lowercase hex characters".into());
    }
    if !is_hex_id(&op.device_id) {
        return Err("device_id must be 32 lowercase hex characters".into());
    }
    if op.hlc.device != op.device_id {
        return Err("hlc device must match device_id".into());
    }
    if op.hlc.wall < 0 {
        return Err("hlc wall must not be negative".into());
    }
    if !is_safe_uid(&op.entity_uid) {
        return Err("entity_uid contains unsupported characters".into());
    }
    if let Some(book_uid) = &op.book_uid {
        if !is_safe_uid(book_uid) {
            return Err("book_uid contains unsupported characters".into());
        }
    }
    if op.deleted && !op.fields.is_empty() {
        return Err("a delete operation carries prior state, not fields".into());
    }
    if op.restore && op.deleted {
        return Err("a restore cannot also be a delete".into());
    }
    if op.kind == EntityKind::BookIdentity {
        if op.deleted {
            return Err("book identity operations cannot be deletes".into());
        }
        if op.book_uid.as_deref() != Some(op.entity_uid.as_str()) {
            return Err("book identity entity_uid must equal book_uid".into());
        }
    } else if op.kind == EntityKind::Book {
        if op.book_uid.as_deref() != Some(op.entity_uid.as_str()) {
            return Err("book entity_uid must equal book_uid".into());
        }
    } else if op.kind != EntityKind::Collection
        && op.kind != EntityKind::BookIdentity
        && op.book_uid.is_none()
    {
        return Err("book-scoped operation is missing book_uid".into());
    }
    // A local file deletion never propagates (ADR 0018 D1): there is no
    // file_version delete, so a hostile one cannot tombstone the pointer.
    if op.kind == EntityKind::FileVersion && op.deleted {
        return Err("file_version operations cannot be deletes".into());
    }
    let allowed = field_names(op.kind);
    for (field, value) in &op.fields {
        if !allowed.contains(&field.as_str()) {
            return Err(format!(
                "field {field} is not valid for {}",
                op.kind.as_str()
            ));
        }
        validate_field_value(op.kind, field, value)?;
    }
    if let Some(prior) = &op.prior {
        for (field, value) in prior {
            if !allowed.contains(&field.as_str()) {
                return Err(format!(
                    "prior field {field} is not valid for {}",
                    op.kind.as_str()
                ));
            }
            validate_field_value(op.kind, field, value)?;
        }
    }
    if op.kind == EntityKind::Membership {
        // The entity uid is `<collection_uid>:<book_uid>`; both need to be
        // present and safe. The book uid is also checked above.
        let parts: Vec<&str> = op.entity_uid.split(':').collect();
        if parts.len() != 2 || !is_safe_uid(parts[0]) || !is_safe_uid(parts[1]) {
            return Err("membership entity_uid must be collection:book".into());
        }
    }
    Ok(())
}

fn validate_field_value(kind: EntityKind, field: &str, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    match (kind, field) {
        (EntityKind::Annotation, "kind") => match value.as_str() {
            Some("bookmark") | Some("highlight") => Ok(()),
            _ => Err("annotation kind must be bookmark or highlight".into()),
        },
        (EntityKind::Annotation, "page_number") => positive_integer(value, field),
        (EntityKind::Annotation, "page_fraction") => unit_number(value, field),
        (EntityKind::Annotation, _) => bounded_string(value, field),
        (EntityKind::Progress, "progress_percent") => percent(value),
        (EntityKind::Progress, "progression") => unit_number(value, field),
        (EntityKind::Progress, "character_offset") => non_negative_integer(value, field),
        (EntityKind::Progress, "page_number") => positive_integer(value, field),
        (EntityKind::Progress, "scroll_offset") => number(value, field),
        (EntityKind::Progress, "schema_version") => non_negative_integer(value, field),
        (EntityKind::Progress, _) => bounded_string(value, field),
        (EntityKind::Metadata, "series_index") => number(value, field),
        (EntityKind::Metadata, "authors_customized")
        | (EntityKind::Metadata, "subjects_customized") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err(format!("{field} must be a boolean")),
        },
        (EntityKind::Metadata, "authors") | (EntityKind::Metadata, "subjects") => {
            string_list(value, field)
        }
        (EntityKind::Metadata, _) => bounded_string(value, field),
        (EntityKind::Collection, "name") => {
            let name = value
                .as_str()
                .ok_or_else(|| "collection name must be a string".to_string())?;
            if name.trim().is_empty() {
                return Err("collection name is empty".into());
            }
            if name.len() > MAX_COLLECTION_NAME_BYTES {
                return Err("collection name is too long".into());
            }
            Ok(())
        }
        (EntityKind::Collection, _) => bounded_string(value, field),
        (EntityKind::Membership, "present") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err("membership present must be a boolean".into()),
        },
        (EntityKind::Membership, _) => bounded_string(value, field),
        (EntityKind::Opened, _) => bounded_string(value, field),
        (EntityKind::BookIdentity, "content_hash") => match value.as_str() {
            Some(hash) if is_hex_hash(hash) => Ok(()),
            _ => Err("content_hash must be 64 lowercase hex characters".into()),
        },
        (EntityKind::BookIdentity, _) => Err(format!("unknown identity field {field}")),
        (EntityKind::FileVersion, "content_hash") => match value.as_str() {
            Some(hash) if is_hex_hash(hash) => Ok(()),
            _ => Err("content_hash must be 64 lowercase hex characters".into()),
        },
        (EntityKind::FileVersion, "size") => non_negative_integer(value, field),
        (EntityKind::FileVersion, _) => Err(format!("unknown file_version field {field}")),
        (EntityKind::Book, "snapshot") => bounded_string(value, field),
        (EntityKind::Book, "replacement_book_uid") => match value.as_str() {
            Some(uid) if is_safe_uid(uid) => Ok(()),
            _ => Err("replacement_book_uid must be a safe uid".into()),
        },
        (EntityKind::Book, "discarded") => match value.as_bool() {
            Some(_) => Ok(()),
            None => Err("discarded must be a boolean".into()),
        },
        (EntityKind::Book, _) => Err(format!("unknown book field {field}")),
    }
}

fn bounded_string(value: &Value, field: &str) -> Result<(), String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string or null"))?;
    if text.len() > MAX_FIELD_STRING_BYTES {
        return Err(format!("{field} is too long"));
    }
    Ok(())
}

fn string_list(value: &Value, field: &str) -> Result<(), String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array or null"))?;
    if items.len() > MAX_LIST_ITEMS {
        return Err(format!("{field} has too many entries"));
    }
    for item in items {
        let text = item
            .as_str()
            .ok_or_else(|| format!("{field} entries must be strings"))?;
        if text.len() > 1024 {
            return Err(format!("{field} entry is too long"));
        }
    }
    Ok(())
}

fn positive_integer(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_i64()
        .ok_or_else(|| format!("{field} must be an integer"))?;
    if number < 1 {
        return Err(format!("{field} must be at least 1"));
    }
    Ok(())
}

fn non_negative_integer(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_i64()
        .ok_or_else(|| format!("{field} must be an integer"))?;
    if number < 0 {
        return Err(format!("{field} must not be negative"));
    }
    Ok(())
}

fn number(value: &Value, field: &str) -> Result<(), String> {
    if value.as_f64().is_none() {
        return Err(format!("{field} must be a number"));
    }
    Ok(())
}

fn unit_number(value: &Value, field: &str) -> Result<(), String> {
    let number = value
        .as_f64()
        .ok_or_else(|| format!("{field} must be a number"))?;
    if !(0.0..=1.0).contains(&number) {
        return Err(format!("{field} is outside 0..=1"));
    }
    Ok(())
}

fn percent(value: &Value) -> Result<(), String> {
    let number = value
        .as_f64()
        .ok_or_else(|| "progress_percent must be a number".to_string())?;
    if !(0.0..=100.0).contains(&number) {
        return Err("progress_percent is outside 0..=100".into());
    }
    Ok(())
}

pub fn fields_object(value: Value) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "fields must be an object".to_string())
}
