#!/usr/bin/env bash
# Build the test-only fidelity oracle.
#
# The oracle drives the real GNOME Papers PpsView widget, so this script first
# configures and builds a minimal Papers (libdocument, libview, and the PDF
# backend) from the pinned vendor/papers submodule, then links the harness
# against it. Nothing here enters the TuxBooks product build.
#
# Papers private headers guard geometry symbols with hidden visibility. The
# harness reads PpsView internals (pps_view_get_page_extents, the integer page
# size helper), so the test-only Papers build is configured with
# -Dc_args=-fvisibility=default to export them. The product never links these
# libraries.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
oracle="$(dirname "$here")"
root="$(git -C "$here" rev-parse --show-toplevel)"
src="$root/vendor/papers"
builddir="$here/build/papers-build"
outdir="$here/build"

if [[ ! -f "$src/meson.build" ]]; then
  echo "error: vendor/papers is not checked out" >&2
  echo "run: git -C '$root' submodule update --init vendor/papers" >&2
  exit 1
fi

meson_options=(
  -Dshell=false
  -Dpreviewer=false
  -Dthumbnailer=false
  -Dnautilus=false
  -Ddocumentation=false
  -Duser_doc=false
  -Dtests=false
  -Dfile_tests=false
  -Dkeyring=disabled
  -Dspell_check=disabled
  -Dintrospection=disabled
  -Dcomics=disabled
  -Ddjvu=disabled
  -Dtiff=disabled
  -Dpdf=enabled
  -Dsysprof=disabled
  -Dgtk_unix_print=disabled
  -Dc_args=-fvisibility=default
)

if [[ -f "$builddir/build.ninja" ]]; then
  meson setup --reconfigure "$builddir" "$src" "${meson_options[@]}" >/dev/null
else
  meson setup "$builddir" "$src" "${meson_options[@]}" >/dev/null
fi

ninja -C "$builddir" \
  libdocument/libppsdocument-4.0.so.6.0.0 \
  libview/libppsview-4.0.so.5.0.0 \
  libdocument/backend/libpdfdocument.so \
  libdocument/backend/org.gnome.Papers.PdfDocument.papers-backend

mkdir -p "$outdir"

pkgs="gtk4 libadwaita-1 poppler-glib exempi-2.0 gdk-pixbuf-2.0"
cc="${CC:-cc}"

"$cc" -std=gnu11 -O2 -Wall -Wextra \
  -DPAPERS_COMPILATION -DHAVE_CONFIG_H \
  -DI_KNOW_THE_PAPERS_LIBS_ARE_UNSTABLE_AND_HAVE_TALKED_WITH_THE_AUTHORS \
  -I"$src" -I"$builddir" \
  -I"$src/libview" -I"$src/libview/context" -I"$src/libview/factory" \
  -I"$builddir/libview" \
  -I"$src/libdocument" -I"$builddir/libdocument" \
  -I"$oracle/fixtures" \
  $(pkg-config --cflags $pkgs) \
  "$here/oracle.c" \
  -L"$builddir/libview" -lppsview-4.0 \
  -L"$builddir/libdocument" -lppsdocument-4.0 \
  $(pkg-config --libs $pkgs) \
  -lm \
  -o "$outdir/oracle"

echo "built $outdir/oracle (real PpsView harness)"
