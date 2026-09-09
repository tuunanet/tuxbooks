#!/usr/bin/env python3
"""Fetch the free ebook fixture corpus (tests/fixtures/books/EBooks).

Downloads every book listed in the committed manifest.json from its source,
verifies sha256 BEFORE the file becomes visible at its final path, and
removes nothing else by default. See docs/free-ebook-fixtures.md.

Usage:
    fetch-ebook-fixtures.py            # fill mode: download missing/invalid files
    fetch-ebook-fixtures.py --check    # verify mode: no network, per-file report
    fetch-ebook-fixtures.py --prune    # additionally delete files not in the manifest
    fetch-ebook-fixtures.py --emit-hash FILE
                                       # print sha256 + size of a local file
                                       # (used when adding entries to the manifest)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "tests/fixtures/books/EBooks/manifest.json"
EBOOK_EXTENSIONS = {".epub", ".pdf"}
USER_AGENT = "tuxbooks-fixture-fetcher/1.0"


def load_manifest() -> dict:
    with MANIFEST_PATH.open("rb") as f:
        return json.load(f)


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def entry_status(entry: dict) -> tuple[str, str]:
    """Classify a manifest entry as ok / missing / wrong-size / wrong-hash."""
    path = MANIFEST_PATH.parent / entry["file"]
    if not path.is_file():
        return "missing", ""
    actual_size = path.stat().st_size
    if actual_size != entry["sizeBytes"]:
        return "wrong-size", f"expected {entry['sizeBytes']}, found {actual_size}"
    actual_hash = hash_file(path)
    if actual_hash != entry["sha256"]:
        return "wrong-hash", f"expected {entry['sha256']}, found {actual_hash}"
    return "ok", ""


def fetch(entry: dict) -> tuple[str, str]:
    """Download one manifest entry, verify it, atomically move it into place."""
    path = MANIFEST_PATH.parent / entry["file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        entry["url"], headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(request, timeout=120) as response, tempfile.NamedTemporaryFile(
        dir=path.parent, delete=False
    ) as tmp:
        for chunk in iter(lambda: response.read(1 << 20), b""):
            tmp.write(chunk)
        tmp_path = Path(tmp.name)
    try:
        actual_hash = hash_file(tmp_path)
        if actual_hash != entry["sha256"]:
            return entry["file"], f"HASH MISMATCH: expected {entry['sha256']}, got {actual_hash}"
        if tmp_path.stat().st_size != entry["sizeBytes"]:
            return entry["file"], "SIZE MISMATCH after download"
        tmp_path.replace(path)
        return entry["file"], "ok"
    finally:
        tmp_path.unlink(missing_ok=True)


def corpus_files() -> set[Path]:
    return {
        p
        for p in MANIFEST_PATH.parent.rglob("*")
        if p.is_file() and p.suffix.lower() in EBOOK_EXTENSIONS
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify only, no downloads")
    parser.add_argument("--prune", action="store_true", help="delete ebook files not in the manifest")
    parser.add_argument("--emit-hash", metavar="FILE", help="print sha256 and size of a local file")
    args = parser.parse_args()

    if args.emit_hash:
        target = Path(args.emit_hash)
        print(f'{hash_file(target)}  {target.stat().st_size}  {target.name}')
        return 0

    manifest = load_manifest()
    failures: list[str] = []

    statuses = {entry["file"]: entry_status(entry) for entry in manifest["books"]}
    for file, (status, detail) in sorted(statuses.items()):
        print(f"  {status:12s} {file}" + (f" ({detail})" if detail else ""))
        if status != "ok":
            failures.append(file)

    manifest_files = {MANIFEST_PATH.parent / e["file"] for e in manifest["books"]}
    strays = sorted(corpus_files() - manifest_files)
    for stray in strays:
        print(f"  stray        {stray.relative_to(MANIFEST_PATH.parent)}")
        if args.prune:
            stray.unlink()
            print(f"               (deleted)")

    if failures and args.check:
        print(f"\ncheck FAILED: {len(failures)} manifest file(s) missing or invalid.")
        print("Run `just fetch-ebooks` to (re)download them.")
        return 1

    if args.check:
        print(f"\ncheck OK: all {len(manifest['books'])} corpus files verified.")
        return 0

    stale = [f for f, (status, _) in statuses.items() if status != "ok"]
    if not stale:
        print(f"\nCorpus already complete ({len(manifest['books'])} files). Nothing to download.")
        return 0

    print(f"\nDownloading {len(stale)} file(s)...")
    entries = [e for e in manifest["books"] if e["file"] in stale]
    download_failures: list[str] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for file, result in pool.map(fetch, entries):
            print(f"  {result:12s} {file}")
            if result != "ok":
                download_failures.append(file)
    if download_failures:
        print("\nfetch FAILED for some files; re-run to retry.")
        return 1
    if failures:
        print("\nfetch FAILED for some files; re-run to retry.")
        return 1
    print(f"\nCorpus complete ({len(manifest['books'])} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
