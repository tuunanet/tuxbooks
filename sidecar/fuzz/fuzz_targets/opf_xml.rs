#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "fuzz_limits.rs"]
mod fuzz_limits;

use tuxbooks_lib::epub::metadata::parse_opf;
use tuxbooks_lib::epub::parse_container_xml;

// OPF/XML manifest surface (issue #88): the same bytes go through both
// manifest parsers, the package document and the container document.
fuzz_target!(|data: &[u8]| {
    let limits = &fuzz_limits::limits();
    let xml = String::from_utf8_lossy(data);
    let _ = parse_opf(&xml, limits);
    let _ = parse_container_xml(data, limits);
});
