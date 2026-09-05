use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// What kind of reading annotation a row holds. Stored as its lowercase
/// name in the `annotations.kind` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Bookmark,
    Highlight,
}

/// One normalized highlight rect in page space (0..1 on both axes),
/// carried inside the `geometry` JSON column of PDF highlights.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnnotationRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A persistent reading annotation (bookmark or highlight, optionally with
/// an attached note). Mirrors the `annotations` table.
///
/// Locators are stable document coordinates, never UI pixels: EPUB
/// annotations locate via canonical CFI (+ spine href for grouping), PDF
/// annotations via a 1-based page number with an optional page-local
/// fraction; PDF highlights additionally keep `geometry`, a JSON array of
/// rects normalized to page space so they redraw correctly at any zoom.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    pub kind: AnnotationKind,
    pub cfi: Option<String>,
    pub chapter_href: Option<String>,
    pub page_number: Option<i64>,
    pub page_fraction: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
    /// JSON-encoded `Vec<AnnotationRect>` (PDF highlights); `None` otherwise.
    pub geometry: Option<String>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
}

/// Writable payload of a new annotation. `book_id` is passed separately.
#[derive(Debug, Clone, PartialEq)]
pub struct NewAnnotation {
    pub kind: AnnotationKind,
    pub cfi: Option<String>,
    pub chapter_href: Option<String>,
    pub page_number: Option<i64>,
    pub page_fraction: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
    /// JSON-encoded `Vec<AnnotationRect>` (PDF highlights).
    pub geometry: Option<String>,
}

/// Editable subset of an existing annotation: highlight color and the
/// attached note. Locators are immutable once created.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AnnotationPatch {
    pub color: Option<String>,
    pub note: Option<String>,
}
