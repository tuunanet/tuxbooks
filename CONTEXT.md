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

## PDF colour

**Color mode**:
The stored reader setting that decides how PDF pages are painted: default,
paper, dark, or invert.
_Avoid_: theme, dark mode

**Smart Dark**:
Object-level recoloring of PDF page content, applied before rasterization, which
remaps each drawing operation's paint colours while leaving photographs alone. A
MuPDF capability retired with that engine.
_Avoid_: dark mode

**Color scheme**:
Category-level recoloring of PDF page content: path fill and stroke, text fill
and stroke. The coarse successor to Smart Dark.

## Verification

**Fidelity oracle**:
A native GNOME Papers build used as the authority for what correct view geometry
is. Tests compare the reimplemented geometry against it.
_Avoid_: reference implementation
