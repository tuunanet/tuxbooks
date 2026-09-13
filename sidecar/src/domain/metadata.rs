use serde::{Deserialize, Serialize};

/// One complete set of bibliographic metadata — used both for the effective
/// (override-over-source) view and the raw source view in [`BookMetadata`].
/// `series` is the series *name*; the normalized id never crosses the IPC
/// boundary. Also the wire shape of the metadata edit form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFields {
    pub title: String,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub publication_date: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub authors: Vec<String>,
    pub subjects: Vec<String>,
}

/// Which fields a user has overridden away from the source-file values
/// (milestone 7). Drives the "modified" hints and the reset affordance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataOverridden {
    pub title: bool,
    pub subtitle: bool,
    pub publisher: bool,
    pub language: bool,
    pub isbn: bool,
    pub description: bool,
    pub publication_date: bool,
    pub series: bool,
    pub cover: bool,
    pub authors: bool,
    pub subjects: bool,
}

/// Which layer is authoritative for one field (issue #58, phase 4). Absence
/// from [`MetadataFieldSources`] means the default: library override when one
/// exists, otherwise the file value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataFieldSource {
    Library,
    File,
}

/// Explicit per-field authority choices for a book. `None` = default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFieldSources {
    pub title: Option<MetadataFieldSource>,
    pub subtitle: Option<MetadataFieldSource>,
    pub publisher: Option<MetadataFieldSource>,
    pub language: Option<MetadataFieldSource>,
    pub isbn: Option<MetadataFieldSource>,
    pub description: Option<MetadataFieldSource>,
    pub publication_date: Option<MetadataFieldSource>,
    /// The series name and index travel as one unit.
    pub series: Option<MetadataFieldSource>,
    pub authors: Option<MetadataFieldSource>,
    pub subjects: Option<MetadataFieldSource>,
}

/// Full curation view of one book: the effective metadata every reader path
/// shows, the untouched source-file values, and which fields differ.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMetadata {
    pub book_id: i64,
    pub effective: MetadataFields,
    pub source: MetadataFields,
    pub overridden: MetadataOverridden,
    /// Effective cover (override if present, else the extracted cache path).
    pub cover_path: Option<String>,
    /// The extracted cover stored in the source-file snapshot. Differs from
    /// `cover_path` when the user picked a library cover.
    pub source_cover_path: Option<String>,
    /// Explicit per-field authority choices; `None` fields use the default.
    pub field_sources: MetadataFieldSources,
}
