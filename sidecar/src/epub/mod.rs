//! EPUB parsing is worker-internal (ADR 0001 D5): the path-based entry
//! points exist for tests and as thin wrappers over the reader cores, and
//! services must reach parsing only through the worker client
//! (`worker::WorkerClient`), never these functions directly.

pub mod metadata;
pub mod parser;
pub mod session;
pub mod writer;

pub use metadata::EpubMetadata;
pub use parser::{
    file_properties_from_metadata, parse_container_xml, parse_epub, parse_epub_reader,
    read_file_properties, read_file_properties_reader, CoverImage, EpubBook,
};
pub use session::{
    build_session, build_session_reader, guess_member_media_type, read_member, read_member_reader,
    EpubReadingSession,
};
pub use writer::{rewrite_epub_bytes, write_metadata};

/// Errors that can occur while opening or parsing an EPUB file.
#[derive(Debug, thiserror::Error)]
pub enum EpubError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a zip archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("not a valid EPUB container: missing `mimetype` entry as first entry")]
    MissingMimetype,
    #[error("not a valid EPUB container: `mimetype` must be `application/epub+zip`")]
    InvalidMimetype,
    #[error("missing META-INF/container.xml")]
    MissingContainer,
    #[error("container.xml is malformed: {0}")]
    ContainerXml(String),
    #[error("container.xml declares no OPF rootfile")]
    NoRootfile,
    #[error("missing package document (OPF): {0}")]
    MissingOpf(String),
    #[error("package document (OPF) is malformed: {0}")]
    OpfXml(String),
    #[error("package document has no dc:title")]
    MissingTitle,
    #[error("spine references unknown manifest id `{0}`")]
    BrokenSpine(String),
    #[error("manifest item `{0}` has no href")]
    ManifestItemWithoutHref(String),
    #[error("EPUB references a non-local resource: {0}")]
    ExternalRef(String),
    #[error("invalid EPUB member path: {0}")]
    InvalidMemberPath(String),
    #[error("{0}")]
    Limit(#[from] crate::limits::LimitExceeded),
}

impl From<crate::limits::ReadBoundedError> for EpubError {
    fn from(err: crate::limits::ReadBoundedError) -> Self {
        match err {
            crate::limits::ReadBoundedError::Limit(limit) => EpubError::Limit(limit),
            crate::limits::ReadBoundedError::Io(io) => EpubError::Io(io),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::epub::parser::tests_support::write_zip;
    use crate::limits::ResourceLimits;

    use super::*;

    #[test]
    fn not_a_zip_reports_zip_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("garbage.epub");
        std::fs::write(&path, b"definitely not a zip archive").unwrap();
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::Zip(_)), "got: {err:?}");
    }

    #[test]
    fn empty_zip_reports_missing_mimetype() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty.epub");
        write_zip(&path, &[]);
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::MissingMimetype), "got: {err:?}");
    }

    #[test]
    fn wrong_mimetype_reports_invalid_mimetype() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("wrong.epub");
        write_zip(&path, &[("mimetype", b"application/zip")]);
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::InvalidMimetype), "got: {err:?}");
    }

    #[test]
    fn mimetype_not_first_entry_reports_missing_mimetype() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("late.epub");
        write_zip(
            &path,
            &[
                ("META-INF/container.xml", b"<container/>".as_slice()),
                ("mimetype", "application/epub+zip".as_bytes()),
            ],
        );
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::MissingMimetype), "got: {err:?}");
    }

    #[test]
    fn missing_container_xml_reports_missing_container() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nocontainer.epub");
        write_zip(&path, &[("mimetype", "application/epub+zip".as_bytes())]);
        let err = parse_epub(&path, &ResourceLimits::DEFAULTS).unwrap_err();
        assert!(matches!(err, EpubError::MissingContainer), "got: {err:?}");
    }
}
