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
}
