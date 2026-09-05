use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::{Annotation, AnnotationKind, AnnotationPatch, AnnotationRect, NewAnnotation};
use crate::error::AppError;
use crate::services::annotations as service;
use crate::AppState;

/// One normalized highlight rect in page space (0..1), mirroring
/// `domain::AnnotationRect` on the wire.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RectInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<RectInput> for AnnotationRect {
    fn from(rect: RectInput) -> Self {
        AnnotationRect {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

impl From<AnnotationRect> for RectInput {
    fn from(rect: AnnotationRect) -> Self {
        RectInput {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

/// Wire shape of a new annotation. EPUB annotations carry `cfi`
/// (+ `chapterHref`), PDF annotations `pageNumber` (+ optional
/// `pageFraction`); PDF highlights also carry `rects` (normalized
/// page-space highlight rectangles, stored as the geometry JSON column).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    pub kind: AnnotationKind,
    pub cfi: Option<String>,
    pub chapter_href: Option<String>,
    pub page_number: Option<i64>,
    pub page_fraction: Option<f64>,
    pub text: Option<String>,
    pub color: Option<String>,
    pub rects: Option<Vec<RectInput>>,
}

impl AnnotationInput {
    fn into_new(self) -> Result<NewAnnotation, AppError> {
        let geometry = match self.rects {
            None => None,
            Some(rects) => Some(
                serde_json::to_string(
                    &rects
                        .into_iter()
                        .map(AnnotationRect::from)
                        .collect::<Vec<_>>(),
                )
                .map_err(|err| AppError::InvalidInput(format!("bad geometry: {err}")))?,
            ),
        };
        Ok(NewAnnotation {
            kind: self.kind,
            cfi: self.cfi,
            chapter_href: self.chapter_href,
            page_number: self.page_number,
            page_fraction: self.page_fraction,
            text: self.text,
            color: self.color,
            geometry,
        })
    }
}

/// Wire shape of the editable fields (highlight color, attached note).
/// `note` replaces the stored note: `Some` sets it (empty string clears),
/// `None` keeps it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationPatchInput {
    pub color: Option<String>,
    pub note: Option<String>,
}

/// A stored annotation, with `geometry` decoded into typed rects for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDto {
    #[serde(flatten)]
    pub annotation: Annotation,
    pub rects: Option<Vec<RectInput>>,
}

impl AnnotationDto {
    fn from_row(row: Annotation) -> Self {
        let rects = row
            .geometry
            .as_deref()
            .and_then(|json| service::parse_geometry(json).ok())
            .map(|rects| rects.into_iter().map(RectInput::from).collect());
        AnnotationDto {
            annotation: row,
            rects,
        }
    }
}

/// Every annotation of one book, in document order.
#[tauri::command]
pub async fn list_annotations(
    state: State<'_, AppState>,
    book_id: i64,
) -> Result<Vec<AnnotationDto>, AppError> {
    Ok(service::list_annotations(&state.db, book_id)
        .await?
        .into_iter()
        .map(AnnotationDto::from_row)
        .collect())
}

/// Creates a bookmark or highlight and returns the stored row.
#[tauri::command]
pub async fn create_annotation(
    state: State<'_, AppState>,
    book_id: i64,
    annotation: AnnotationInput,
) -> Result<AnnotationDto, AppError> {
    let stored = service::create_annotation(&state.db, book_id, &annotation.into_new()?).await?;
    Ok(AnnotationDto::from_row(stored))
}

/// Updates an annotation's color and note; null when the id does not exist.
#[tauri::command]
pub async fn update_annotation(
    state: State<'_, AppState>,
    id: i64,
    patch: AnnotationPatchInput,
) -> Result<Option<AnnotationDto>, AppError> {
    let updated = service::update_annotation(
        &state.db,
        id,
        &AnnotationPatch {
            color: patch.color,
            note: patch.note,
        },
    )
    .await?;
    Ok(updated.map(AnnotationDto::from_row))
}

/// Deletes an annotation; true when a row was removed.
#[tauri::command]
pub async fn delete_annotation(state: State<'_, AppState>, id: i64) -> Result<bool, AppError> {
    service::delete_annotation(&state.db, id).await
}
