//! Wire and state types for cloud-folder sync (docs/SYNC.md).
//!
//! Operation files are immutable JSON documents written under
//! `ops/<device>/`. The shared state is a materialized view of the operations:
//! one entity row plus one row per field with the clock that last wrote it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Bump only with a documented migration of the on-disk format. Readers reject
/// a newer schema instead of guessing.
pub const OP_SCHEMA: u32 = 1;
/// One operation file is small. Covers travel as separate content-addressed
/// blobs.
pub const MAX_OP_FILE_BYTES: u64 = 1 << 20;
/// Keep one hostile field from becoming an unbounded allocation.
pub const MAX_FIELD_STRING_BYTES: usize = 512 * 1024;
pub const MAX_COLLECTION_NAME_BYTES: usize = 512;
pub const MAX_LIST_ITEMS: usize = 512;
pub const TRASH_DAYS: i64 = 30;

/// Hybrid logical clock. Ordering is `(wall, counter, device)`; the device id
/// is the deterministic tie-breaker when two writes share a physical
/// millisecond.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Hlc {
    pub wall: i64,
    pub counter: u32,
    pub device: String,
}

impl Hlc {
    pub fn zero() -> Self {
        Self {
            wall: 0,
            counter: 0,
            device: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Annotation,
    Progress,
    Metadata,
    Collection,
    Membership,
    Opened,
    BookIdentity,
    /// Whole-book Forget/restore lifecycle (ADR 0014 D5). `entity_uid` is the
    /// forgotten book uid.
    Book,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Annotation => "annotation",
            Self::Progress => "progress",
            Self::Metadata => "metadata",
            Self::Collection => "collection",
            Self::Membership => "membership",
            Self::Opened => "opened",
            Self::BookIdentity => "book_identity",
            Self::Book => "book",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "annotation" => Self::Annotation,
            "progress" => Self::Progress,
            "metadata" => Self::Metadata,
            "collection" => Self::Collection,
            "membership" => Self::Membership,
            "opened" => Self::Opened,
            "book_identity" => Self::BookIdentity,
            "book" => Self::Book,
            _ => return None,
        })
    }

    /// Progress is one coherent locator: mixing fields from two devices would
    /// create a position neither device ever had. Membership and opened are
    /// single-value records, so the same rule is simpler and safe. Every other
    /// kind merges per field, which is what lets one device edit a note while
    /// another changes a highlight colour.
    pub fn merge_mode(self) -> MergeMode {
        match self {
            Self::Progress | Self::Membership | Self::Opened | Self::Book => MergeMode::Entity,
            _ => MergeMode::Field,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    Field,
    Entity,
}

/// A generated operation. `fields` carries only changed fields; a cleared
/// field is present with JSON `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub schema: u32,
    pub op_id: String,
    pub device_id: String,
    pub hlc: Hlc,
    pub kind: EntityKind,
    pub entity_uid: String,
    #[serde(default)]
    pub book_uid: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    /// Restore a tombstoned entity. Only the explicit trash action sets this;
    /// a concurrent edit never resurrects a delete.
    #[serde(default)]
    pub restore: bool,
    #[serde(default)]
    pub fields: Map<String, Value>,
    /// The prior canonical state, carried by deletes so any device can offer
    /// the 30-day restore even if it never held the entity.
    #[serde(default)]
    pub prior: Option<Map<String, Value>>,
    pub created_at: String,
}

/// Canonical state is an ordered map so comparisons and serialized snapshots
/// are stable.
pub type State = BTreeMap<String, Value>;

pub fn field_names(kind: EntityKind) -> &'static [&'static str] {
    match kind {
        EntityKind::Annotation => &[
            "kind",
            "cfi",
            "chapter_href",
            "page_number",
            "page_fraction",
            "text",
            "color",
            "geometry",
            "note",
            "label",
            "created_at",
        ],
        EntityKind::Progress => &[
            "chapter_href",
            "cfi",
            "character_offset",
            "page_number",
            "scroll_offset",
            "progress_percent",
            "locator",
            "progression",
            "locations",
            "engine",
            "schema_version",
        ],
        EntityKind::Metadata => &[
            "title",
            "subtitle",
            "publisher",
            "language",
            "isbn",
            "description",
            "publication_date",
            "series",
            "series_index",
            "cover_path",
            "authors_customized",
            "authors",
            "subjects_customized",
            "subjects",
        ],
        EntityKind::Collection => &["name", "created_at"],
        EntityKind::Membership => &["present", "added_at"],
        EntityKind::Opened => &["last_opened_at"],
        EntityKind::BookIdentity => &["content_hash"],
        // The snapshot is a serialized portable book snapshot. `discarded`
        // closes the remote trash entry after a local Keep/Merge resolution.
        EntityKind::Book => &["snapshot", "replacement_book_uid", "discarded"],
    }
}

/// Turn a trigger snapshot (which also carries local ids) into the canonical
/// state: exactly the syncable fields, with every field present once.
pub fn canonical_from_snapshot(kind: EntityKind, snapshot: &Map<String, Value>) -> State {
    field_names(kind)
        .iter()
        .map(|field| {
            (
                (*field).to_string(),
                snapshot.get(*field).cloned().unwrap_or(Value::Null),
            )
        })
        .collect()
}

/// The subset of `state` that differs from `previous`, plus fields that were
/// explicitly cleared. Unknown keys are ignored.
pub fn changed_fields(previous: &State, current: &State) -> Map<String, Value> {
    let mut changed = Map::new();
    for (field, value) in current {
        match previous.get(field) {
            Some(old) if old == value => {}
            _ => {
                changed.insert(field.clone(), value.clone());
            }
        }
    }
    changed
}

/// Stable issue key for one conflict. Several losing writes for the same field
/// share the key, so the issue closes only when the last of them settles.
pub fn conflict_issue_key(kind: EntityKind, entity_uid: &str, field: &str) -> String {
    format!("conflict:{}:{entity_uid}:{field}", kind.as_str())
}

pub fn state_display(kind: EntityKind, state: &State) -> String {
    match kind {
        EntityKind::Annotation => state
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| state.get("label").and_then(Value::as_str))
            .unwrap_or("annotation")
            .chars()
            .take(80)
            .collect(),
        EntityKind::Collection => state
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("collection")
            .to_string(),
        EntityKind::Metadata => "metadata edit".to_string(),
        EntityKind::Progress => "reading progress".to_string(),
        EntityKind::Opened => "last opened".to_string(),
        EntityKind::Membership => "collection membership".to_string(),
        EntityKind::BookIdentity => "book identity".to_string(),
        EntityKind::Book => "forgotten book".to_string(),
    }
}

pub fn is_hex_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_safe_uid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
        && !value.contains("..")
        && !value.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hlc_order_is_wall_then_counter_then_device() {
        let a = Hlc {
            wall: 10,
            counter: 0,
            device: "a".into(),
        };
        let b = Hlc {
            wall: 10,
            counter: 1,
            device: "a".into(),
        };
        let c = Hlc {
            wall: 10,
            counter: 1,
            device: "b".into(),
        };
        assert!(a < b && b < c);
    }

    #[test]
    fn snapshot_fills_missing_fields_with_null() {
        let snapshot = json!({"kind": "bookmark", "cfi": "epubcfi(/6/4)", "book_id": 3});
        let state = canonical_from_snapshot(EntityKind::Annotation, snapshot.as_object().unwrap());
        assert_eq!(state.get("kind"), Some(&json!("bookmark")));
        assert_eq!(state.get("note"), Some(&Value::Null));
        assert!(!state.contains_key("book_id"));
    }

    #[test]
    fn changed_fields_reports_clears() {
        let mut previous = State::new();
        previous.insert("note".into(), json!("remember"));
        previous.insert("color".into(), json!("yellow"));
        let mut current = previous.clone();
        current.insert("note".into(), Value::Null);
        let changed = changed_fields(&previous, &current);
        assert_eq!(changed.get("note"), Some(&Value::Null));
        assert_eq!(changed.len(), 1);
    }

    #[test]
    fn uid_charset_rejects_traversal() {
        assert!(is_safe_uid("abc-123_def"));
        assert!(!is_safe_uid("../evil"));
        assert!(!is_safe_uid(".hidden"));
        assert!(!is_safe_uid(""));
    }

    #[test]
    fn state_display_names_each_entity_kind_for_the_trash_list() {
        let mut annotation = State::new();
        annotation.insert("text".into(), json!("A highlighted passage"));
        assert_eq!(
            state_display(EntityKind::Annotation, &annotation),
            "A highlighted passage"
        );
        let mut bookmark = State::new();
        bookmark.insert("label".into(), json!("Chapter 3"));
        assert_eq!(
            state_display(EntityKind::Annotation, &bookmark),
            "Chapter 3"
        );
        assert_eq!(
            state_display(EntityKind::Annotation, &State::new()),
            "annotation"
        );

        let mut collection = State::new();
        collection.insert("name".into(), json!("Favorites"));
        assert_eq!(
            state_display(EntityKind::Collection, &collection),
            "Favorites"
        );
        assert_eq!(
            state_display(EntityKind::Collection, &State::new()),
            "collection"
        );
        assert_eq!(
            state_display(EntityKind::Metadata, &State::new()),
            "metadata edit"
        );
        assert_eq!(
            state_display(EntityKind::Progress, &State::new()),
            "reading progress"
        );
        assert_eq!(
            state_display(EntityKind::Opened, &State::new()),
            "last opened"
        );
        assert_eq!(
            state_display(EntityKind::Membership, &State::new()),
            "collection membership"
        );
        assert_eq!(
            state_display(EntityKind::BookIdentity, &State::new()),
            "book identity"
        );
        assert_eq!(
            state_display(EntityKind::Book, &State::new()),
            "forgotten book"
        );
    }
}
