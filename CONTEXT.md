# TuxBooks

TuxBooks is a local-first ebook library and reader for EPUB and PDF. This
context covers the vocabulary shared by the library, the readers, and the
document workers.

## Documents and engines

**Papers**:
GNOME's document viewer, formerly Evince. The reference point for TuxBooks' PDF
view behaviour.
_Avoid_: Evince (the earlier name)

**Engine**:
The component that turns document bytes into page rasters, page sizes, text
geometry, outline, and search results. PDF and EPUB each have one.
_Avoid_: backend, viewer

**Engine seam**:
The boundary between the reader and its document engine. Reader code must not
depend on which engine is installed. Only the engine adapter crosses the seam.
_Avoid_: wrapper, abstraction layer

**Renderer**:
The Electron renderer process, where the reader UI runs. Not the document
engine.
_Avoid_: renderer (for the engine)

## PDF view

**View geometry**:
The layout and zoom mathematics that turn a document's page sizes and a zoom
state into page rectangles and scroll offsets. It is independent of the engine
and the UI framework.
_Avoid_: layout, zoom logic

**Reading anchor**:
The document point the reader holds across a position change: the viewport top
plus a quarter of the viewport height.
_Avoid_: scroll anchor

**Focal anchor**:
The document point under the pointer during a zoom, which the reader holds fixed
while the scale changes.
_Avoid_: zoom center

**Keep-position**:
The scroll policy that preserves the reader's relative position through a
re-layout, as opposed to centering.
_Avoid_: preserve scroll

**Center on zoom**:
The scroll policy that holds the focal anchor fixed through an explicit zoom.

**Scale-and-swap**:
Holding a page's previous bitmap on screen, scaled to the new page box, while
its new-scale raster runs, then replacing it in one atomic blit. The visible
surface never blanks through a zoom commit.
_Avoid_: placeholder, stale raster

## PDF colour

**Color mode**:
The stored reader setting that decides how PDF pages are painted: default,
paper, dark, or invert.
_Avoid_: theme, dark mode

**Smart dark**:
The PDF reader's dark color mode, labeled "Smart dark" in the appearance menu. It
rasterizes each page through PDFium's category colour scheme, so path and text
colours are remapped while photographs keep their pixels.
_Avoid_: dark mode

**Color scheme**:
PDFium's category-level recoloring: path fill and stroke, text fill and stroke.
The mechanism behind the Smart dark mode, coarser than object-level recoloring.

## Verification

**Fidelity oracle**:
A native GNOME Papers build used as the authority for what correct view geometry
is. Tests compare the reimplemented geometry against it.
_Avoid_: reference implementation
