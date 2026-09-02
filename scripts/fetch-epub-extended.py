#!/usr/bin/env python3
"""Fetch opt-in extended/conformance EPUB datasets (Tiers B and C).

This is the ONLY piece of test infrastructure allowed to touch the network,
and nothing in the default workflow calls it: `just test`, `just check`, and
normal CI never download fixtures (docs/testing.md). It is invoked explicitly
via `just fetch-epub-extended`.

Datasets are declared in tests/fixtures/epub/fixtures.toml as:

  [[dataset]]
  id = "..."                        # cache key component
  version = "..."                   # exact content version
  source = "https://..."            # ONE versioned archive, not per-file fetches
  license = "..."                   # verified redistribution terms
  archive_sha256 = "..."            # checksum of the exact archive
  download_size_bytes = 0           # informational
  tier = "extended" | "conformance"
  retrieved = "YYYY-MM-DD"          # when the checksum was captured

Behavior per dataset: if the cache already holds the version with a matching
checksum, nothing is downloaded. Otherwise the archive is downloaded once,
its sha256 is verified against the manifest (a mismatch aborts before
extraction), and it is extracted into .build/fixtures/epub/<tier>/<id>/<version>/.
The core corpus under tests/fixtures/epub/core/ is never written to.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / "tests" / "fixtures" / "epub" / "fixtures.toml"
CACHE = REPO / ".build" / "fixtures" / "epub"

REQUIRED_FIELDS = (
    "id",
    "version",
    "source",
    "license",
    "archive_sha256",
    "tier",
    "retrieved",
)
VALID_TIERS = ("extended", "conformance")
PROVENANCE_FILE = ".tuxbooks-fixture-provenance.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def already_cached(dataset_dir: Path, expected_sha256: str) -> bool:
    provenance = dataset_dir / PROVENANCE_FILE
    if not provenance.is_file():
        return False
    try:
        recorded = json.loads(provenance.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return recorded.get("archive_sha256") == expected_sha256


def extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(destination)
    elif archive.suffix in (".tar", ".gz", ".bz2", ".xz") or tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            tf.extractall(destination)
    else:
        raise SystemExit(
            f"FAIL: unsupported archive format for {archive.name};"
            " datasets must be zip or tar archives"
        )


def fetch(dataset: dict) -> str:
    missing = [field for field in REQUIRED_FIELDS if not dataset.get(field)]
    if missing:
        raise SystemExit(
            f"FAIL: dataset entry is missing required fields: {', '.join(missing)}."
            " Every dataset needs real provenance before it can be fetched —"
            " see tests/fixtures/epub/extended/README.md"
        )
    if dataset["tier"] not in VALID_TIERS:
        raise SystemExit(
            f"FAIL: dataset tier '{dataset['tier']}' must be one of {VALID_TIERS}"
        )
    sha = dataset["archive_sha256"].lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise SystemExit(
            "FAIL: dataset archive_sha256 must be a real 64-character hex sha256"
            " — placeholder values are rejected (never invent fixture provenance)"
        )

    destination = CACHE / dataset["tier"] / dataset["id"] / dataset["version"]
    if already_cached(destination, dataset["archive_sha256"]):
        return f"cached: {dataset['tier']}/{dataset['id']}@{dataset['version']}"

    if destination.exists():
        shutil.rmtree(destination)  # stale partial fetch for the same version

    print(
        f"fetching {dataset['tier']}/{dataset['id']}@{dataset['version']} from"
        f" {dataset['source']} ..."
    )
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "dataset-archive"
        with urllib.request.urlopen(dataset["source"]) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        actual = sha256_file(archive)
        if actual != dataset["archive_sha256"]:
            raise SystemExit(
                f"FAIL: checksum mismatch for {dataset['id']}@{dataset['version']}:"
                f" manifest says {dataset['archive_sha256']}, downloaded archive is"
                f" {actual}. If upstream changed, pin a new version + checksum in"
                " fixtures.toml; never update the checksum to match a drifted file."
            )
        extract(archive, destination)

    provenance = {
        "id": dataset["id"],
        "version": dataset["version"],
        "source": dataset["source"],
        "license": dataset["license"],
        "archive_sha256": dataset["archive_sha256"],
        "retrieved": dataset["retrieved"],
        "fetched_at": datetime.now(timezone.utc).date().isoformat(),
    }
    (destination / PROVENANCE_FILE).write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )
    return (
        f"fetched + verified: {dataset['tier']}/{dataset['id']}@{dataset['version']}"
        f" -> {destination.relative_to(REPO)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    datasets = tomllib.loads(MANIFEST.read_text(encoding="utf-8")).get("dataset", [])
    if not datasets:
        print(
            "No extended/conformance datasets are configured in"
            f" {MANIFEST.relative_to(REPO)}.\n"
            "This is expected for the first version: entries require verified"
            " provenance (source URL, exact version, license, archive sha256) and"
            " none have been pinned yet.\n"
            "See tests/fixtures/epub/extended/README.md and"
            " tests/fixtures/epub/conformance/README.md for how to add one."
        )
        return 1
    for dataset in datasets:
        print(fetch(dataset))
    return 0


if __name__ == "__main__":
    sys.exit(main())
