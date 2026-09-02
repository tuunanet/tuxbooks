# Extended fixtures (Tier B)

Large, real-world EPUBs used for compatibility testing. **Not committed to
Git and never downloaded by the default test suite** — `just test`, `just
check`, and normal CI run entirely without this directory.

Fetched on demand into the ignored cache directory:

```sh
just fetch-epub-extended     # download + verify into .build/fixtures/epub/extended/
just test-epub-extended      # run the corpus through the real parser (opt-in)
```

Both commands read `[[dataset]]` entries from `tests/fixtures/epub/fixtures.toml`.
The first version ships **zero configured datasets**: adding one requires
verified provenance, and no entry should be invented to populate the
directory.

## Adding a dataset

Append to `fixtures.toml` (all fields required — the fetch script refuses
entries with missing or placeholder values):

```toml
[[dataset]]
id = "real-world-public-domain"        # stable identifier, used as cache key
version = "2026-01-01"                 # exact content version
source = "https://..."                 # URL of ONE versioned archive
license = "Public domain (pre-1928 US publication)"
archive_sha256 = "<sha256 of the exact archive>"
download_size_bytes = 12345678         # informational, for CI planning
tier = "extended"
retrieved = "2026-01-01"               # date the checksum was verified
```

Rules (see `docs/testing.md`):

- One versioned archive per dataset — never a per-file download loop.
- `archive_sha256` is the checksum of the exact archive at `source`; a
  changed upstream file must come with a new `version` and checksum.
- Public-domain material with documented status, explicit open licenses, or
  official test corpora with compatible redistribution terms only. Never
  commercial ebooks. "I can download it" is not "I can redistribute it".
- Record attribution requirements in the dataset entry or a sidecar note.
- Content lands in `.build/fixtures/epub/` (gitignored) — nothing here.
