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

/// A decompression bomb: ~19 MB of zlib-wrapped DEFLATE that inflates to
/// 4095 MiB, wired as a PDF 1.5 cross-reference stream so lopdf must
/// decompress it during load (it decodes xref streams eagerly). The worker's
/// limits table caps that inflation (`max_stream_decompressed_bytes`, wired
/// into lopdf's `max_decompressed_size`), with the worker's 3 GiB RLIMIT_AS
/// behind it as the containment backstop. Construction is deterministic and
/// cheap: the zero run is compressed by the zip crate (the only deflate
/// available to test code, at level 1) and the raw DEFLATE bytes are reused
/// as the stream payload.
pub(crate) fn inflation_bomb() -> Vec<u8> {
    inflation_bomb_at(4095)
}

/// `inflation_bomb()` at a caller-chosen inflated size (in MiB), for tests
/// that pin the typed limit trip with a tight cap and must not allocate the
/// full output.
pub(crate) fn inflation_bomb_at(mib: usize) -> Vec<u8> {
    let raw = deflate_zeros(mib * (1 << 20));
    let mut pdf = Vec::new();
    pdf.extend_from_slice(b"%PDF-1.5\n");
    pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n");
    let xref_stream = pdf.len();
    pdf.extend_from_slice(
        format!(
            "3 0 obj\n<< /Type /XRef /Size 4 /W [1 3 2] /Root 1 0 R /Filter /FlateDecode /Length {} >>\nstream\n",
            raw.len()
        )
        .as_bytes(),
    );
    pdf.extend_from_slice(&raw);
    pdf.extend_from_slice(
        format!("\nendstream\nendobj\nstartxref\n{}\n%%EOF\n", xref_stream).as_bytes(),
    );
    pdf
}

/// Compress `len` zero bytes with the zip crate and wrap the raw DEFLATE
/// member payload into the zlib container PDF FlateDecode carries (2-byte
/// header plus adler32; for a zero run the checksum is closed-form: the
/// high half is `len mod 65521`, the low half 1).
fn deflate_zeros(len: usize) -> Vec<u8> {
    use std::io::Write as _;
    let mut zip_buffer: Vec<u8> = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(1));
        zip.start_file("payload".to_string(), options).unwrap();
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..(len / chunk.len()) {
            zip.write_all(&chunk).unwrap();
        }
        zip.finish().unwrap();
    }
    // Local header layout: sig(4) version(2) flags(2) method(2) time(2)
    // date(2) crc(4) csize(4) usize(4) nlen(2) elen(2) name extra data.
    let buf = &zip_buffer;
    let nlen = u16::from_le_bytes([buf[26], buf[27]]) as usize;
    let elen = u16::from_le_bytes([buf[28], buf[29]]) as usize;
    let csize = u32::from_le_bytes(buf[18..22].try_into().unwrap()) as usize;
    let data_start = 30 + nlen + elen;

    let checksum = (((len as u64) % 65521) << 16) | 1;
    let mut zlib = Vec::with_capacity(csize + 6);
    zlib.extend_from_slice(&[0x78, 0x9C]);
    zlib.extend_from_slice(&buf[data_start..data_start + csize]);
    zlib.extend_from_slice(&(checksum as u32).to_be_bytes());
    zlib
}
