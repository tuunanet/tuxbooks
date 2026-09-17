#![no_main]

use std::io::{BufReader, Cursor};

use libfuzzer_sys::fuzz_target;

#[path = "fuzz_limits.rs"]
mod fuzz_limits;

use tuxbooks_lib::epub::{build_session_reader, parse_epub_reader, read_member_reader};

// EPUB/ZIP surface (issue #88): the whole input is the archive for the
// import parse; two leading mode bytes route to the member-lookup and
// reading-session paths instead.
fuzz_target!(|data: &[u8]| {
    let limits = &fuzz_limits::limits();
    match data.first() {
        // 0x00 + NUL-terminated member path + archive bytes: the member
        // lookup (E-5 path gate + bounded extraction).
        Some(0x00) => {
            let rest = &data[1..];
            let Some(end) = rest.iter().position(|&byte| byte == 0) else {
                return;
            };
            let member = String::from_utf8_lossy(&rest[..end]);
            let archive = BufReader::new(Cursor::new(rest[end + 1..].to_vec()));
            let _ = read_member_reader(archive, &member, limits);
        }
        // 0x01 + archive bytes: the reading-session build (container, OPF,
        // nav/NCX TOC, positions).
        Some(0x01) => {
            let archive = BufReader::new(Cursor::new(data[1..].to_vec()));
            let _ = build_session_reader(archive, limits);
        }
        // Everything else parses whole: ZIP totals, mimetype, container,
        // OPF, spine, cover extraction.
        _ => {
            let archive = BufReader::new(Cursor::new(data.to_vec()));
            let _ = parse_epub_reader(archive, limits);
        }
    }
});
