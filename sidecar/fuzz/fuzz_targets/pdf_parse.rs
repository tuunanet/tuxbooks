#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "fuzz_limits.rs"]
mod fuzz_limits;

use tuxbooks_lib::pdf::parse_pdf_bytes;

// PDF object-parsing surface (issue #88): lopdf load (with the stream
// inflation cap wired to the limits table), the bounded page-tree walk,
// and metadata string decoding.
fuzz_target!(|data: &[u8]| {
    let _ = parse_pdf_bytes(data, &fuzz_limits::limits());
});
