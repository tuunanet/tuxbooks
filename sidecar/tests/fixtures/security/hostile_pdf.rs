//! Hostile PDF corpus builders (issue #87, R-2/P-1 invariants).
//!
//! Same rules as `hostile_epub.rs`: runtime-generated, deterministic,
//! included by `tests/security_corpus.rs` via `#[path]`, reusable as fuzz
//! seeds by #88. Assembler mirrors the parser's own test helper because
//! that one is only visible inside the crate's unit tests.

/// Assemble object bodies into a structurally valid PDF with a correct
/// xref table (same layout the parser test support uses).
pub(crate) fn assemble_pdf(objects: &[String], trailer_extra: &str) -> Vec<u8> {
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }

    let xref_offset = pdf.len();
    pdf.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    pdf.push_str("0000000000 65535 f \n");
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R {trailer_extra} >>\nstartxref\n{xref_offset}\n%%EOF\n",
        objects.len() + 1
    ));
    pdf.into_bytes()
}

pub(crate) fn benign() -> Vec<u8> {
    assemble_pdf(
        &[
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
        ],
        "",
    )
}

/// A structurally valid PDF whose only page declares an extreme MediaBox.
pub(crate) fn huge_page() -> Vec<u8> {
    assemble_pdf(
        &[
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100000 100000] >>".to_string(),
        ],
        "",
    )
}

/// A page tree whose node lists itself, so an unbounded walk never
/// terminates (the node budget is the fence).
pub(crate) fn cyclic_page_tree() -> Vec<u8> {
    assemble_pdf(
        &[
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [2 0 R] /Count 1 >>".to_string(),
        ],
        "",
    )
}

/// A valid PDF whose startxref points into the middle of an object body.
pub(crate) fn bad_startxref() -> Vec<u8> {
    let bytes = benign();
    let mut out = bytes;
    let pos = out
        .windows(10)
        .rposition(|w| w == b"startxref\n")
        .expect("fixture must contain startxref");
    let value = b"0000000020";
    out[pos + 10..pos + 10 + value.len()].copy_from_slice(value);
    out
}
