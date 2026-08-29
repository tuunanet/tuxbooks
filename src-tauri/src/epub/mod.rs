pub mod metadata;
pub mod parser;

pub use metadata::EpubMetadata;
pub use parser::{parse_epub, CoverImage, EpubBook};

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
}

#[cfg(test)]
mod tests {
    use crate::epub::parser::tests_support::write_zip;

    use super::*;

    #[test]
    fn not_a_zip_reports_zip_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("garbage.epub");
        std::fs::write(&path, b"definitely not a zip archive").unwrap();
        let err = parse_epub(&path).unwrap_err();
        assert!(matches!(err, EpubError::Zip(_)), "got: {err:?}");
    }

    #[test]
    fn empty_zip_reports_missing_mimetype() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty.epub");
        write_zip(&path, &[]);
        let err = parse_epub(&path).unwrap_err();
        assert!(matches!(err, EpubError::MissingMimetype), "got: {err:?}");
    }

    #[test]
    fn wrong_mimetype_reports_invalid_mimetype() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("wrong.epub");
        write_zip(&path, &[("mimetype", b"application/zip")]);
        let err = parse_epub(&path).unwrap_err();
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
        let err = parse_epub(&path).unwrap_err();
        assert!(matches!(err, EpubError::MissingMimetype), "got: {err:?}");
    }

    #[test]
    fn missing_container_xml_reports_missing_container() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nocontainer.epub");
        write_zip(&path, &[("mimetype", "application/epub+zip".as_bytes())]);
        let err = parse_epub(&path).unwrap_err();
        assert!(matches!(err, EpubError::MissingContainer), "got: {err:?}");
    }
}
