# Research: how GNOME Papers renders pages during scrolling (opens the new `docs/research/` convention)

This is the first file in `docs/research/`; the directory and convention did
not exist before it.

Scope: how GNOME Papers (the GTK4 successor of Evince, `pps-` prefix) keeps
scrolling robust and visually appealing. Every claim comes from Papers primary
source, plus GTK4 framework source where the behavior lives in GTK; Evince was
available as a secondary primary source but was not needed (see Unverified).
Reference commit: `dd693ee21726fdc08b135183e104b67c0e59b332`
(`GNOME/papers` v51.0, the same pin as `docs/PDF-VIEW.md`), fetched from
`https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/<path>`.
GTK4 framework claims cite `GNOME/gtk` `main`
(`https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c`, retrieved
2026-10-15).

## Questions

1. Page surface lifecycle while scrolling: does Papers ever destroy or hide a
   rendered page's surface because it left a virtualization window, and what
   keeps painted pages on screen (cache structure, retention count, eviction,
   memory bounds, owning file)?
2. Render scheduling during scroll: paused or continuous, job queue priorities,
   how superseded or stale jobs are cancelled or deprioritized, concurrency,
   which thread runs rasters, what stops a scroll from queueing pointless work.
3. Progressive quality: does a page paint at low resolution first and refine in
   place, and how is the swap done without a blank frame?
4. What the user sees while a page has not rendered yet (placeholder styling,
   previous frame retention, blank-rect avoidance).
5. Scroll-time compositing cost: how the view avoids re-rasterizing every frame
   (snapshot, texture reuse, damage tracking).

## Page surface lifecycle while scrolling

**Who owns the pixels.** Rendered pages live in `PpsPixbufCache`, not in the
per-page widgets. The cache holds one `CacheJobInfo` per page slot: a
`job_list` for the visible page range plus `prev_job` / `next_job` arrays for
pages just outside it
([libview/pps-pixbuf-cache.c:10-67](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
Each slot carries the page's `GdkTexture` and at most one running job.

**Who owns the widgets.** The view pre-creates a fixed pool of 25
`PpsViewPage` widgets once at init
(`PAGE_WIDGET_POOL_SIZE`, [libview/pps-view.c:91](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c),
[libview/pps-view.c:6279-6286](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
Scrolling never creates or destroys page widgets: `view_update_range_and_current_page`
grows the pool only if the visible range exceeds 25 pages, then reassigns
widgets to page indices with modulo arithmetic
([libview/pps-view.c:760-791](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c));
widgets are unparented only when the view itself is disposed
([libview/pps-view.c:5550](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).

**So: does a page ever get hidden or destroyed for leaving the window?**
Partly, in two separate senses:

- The widget is unmapped, not destroyed. In `pps_view_size_allocate` each page
  widget's `child_visible` is set to whether its rect intersects the viewport
  ([libview/pps-view.c:3496-3517](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
  GTK maps `set_child_visible(FALSE)` to `gtk_widget_unmap`
  ([gtkwidget.c:7052-7091](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)),
  and an unmapped child is skipped by `gtk_widget_snapshot_child`
  ([gtkwidget.c:12629-12648](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).
  The widget and the cache texture keyed by its page index both survive.
- The texture is evicted only when the page falls outside
  `[start_page - preload, end_page + preload]`. On a range change,
  `move_one_job` carries each still-relevant slot (texture included) into the
  new array and disposes only out-of-window slots, cancelling their jobs
  ([libview/pps-pixbuf-cache.c:347-400](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c),
  [libview/pps-pixbuf-cache.c:471-565](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
  The comment at the entry point says it plainly: "We cull old pages
  mercilessly" ([libview/pps-pixbuf-cache.c:838-840](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).

**How much is retained.** Visible pages are kept unconditionally; the preload
ring holds up to `MAX_PRELOADED_PAGES 3` pages before and after the visible
range
([libview/pps-pixbuf-cache.c:105](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)),
and the ring shrinks with the byte budget: `pps_pixbuf_cache_get_preload_size`
adds pages one at a time while they fit, and returns 0 preload when the visible
range alone already fills the budget
([libview/pps-pixbuf-cache.c:416-469](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
The budget is 50 MB by default
(`DEFAULT_PIXBUF_CACHE_SIZE`,
[libview/pps-view.c:97](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c),
[libview/pps-view.c:6264](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
The visible range is explicitly exempt from that budget: the setter's doc
comment says the limit "doesn't affect the current visible page range, which
will always be rendered" and points at `max_scale` for the total-memory bound
([libview/pps-view.c:6370-6391](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
That `max_scale` is computed so one largest-page RGBA buffer fits the budget:
`max_scale = sqrt(pixbuf_cache_size / (max_width * 4 * max_height))`, also
clamped by cairo's 32767 px image limit
([libview/pps-view.c:5651-5676](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).

**Eviction mechanics.** Dropping a slot runs `end_job`, which cancels the
job unless it already finished, then unrefs the texture
([libview/pps-pixbuf-cache.c:165-194](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
Shrinking the budget clears the whole cache
([libview/pps-pixbuf-cache.c:233-243](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
Eviction is never driven by scroll velocity: it is driven only by the window
moving past a page or by the byte budget.

## Render scheduling during scroll

**Rendering is never paused during a scroll.** A scroll changes the visible
range, which re-prioritizes and re-queues work; nothing gates it on "is the
user scrolling". The scroll direction only decides the _order_ preload jobs are
queued in: `pps_pixbuf_cache_add_jobs_if_needed` pushes preload jobs toward the
scroll direction first
([libview/pps-pixbuf-cache.c:772-798](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c),
direction from [libview/pps-pixbuf-cache.c:800-818](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).

**Priorities.** Four levels: `URGENT` = current page range, `HIGH` = current
thumbnail range, `LOW` = pages not in current range, `NONE` = anything else
([libview/pps-job-scheduler.h:22-25](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.h)).
Visible-range slots are queued `URGENT`, preload slots `LOW`
([libview/pps-pixbuf-cache.c:376-390](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c),
[libview/pps-pixbuf-cache.c:742-788](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
When a slot is promoted from preload to visible, the running job's priority is
updated too
([libview/pps-pixbuf-cache.c:397-399](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).

**The queue.** Jobs go into one `GThreadPool` sorted by priority ascending, so
URGENT always dequeues before LOW
([libview/pps-job-scheduler.c:79-114](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.c)).
`pps_job_scheduler_update_job` moves a promoted job to the front of the queue,
but only for `URGENT`; there is no demotion call
([libview/pps-job-scheduler.c:139-149](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.c)).
At this commit the pool runs **exactly 1 worker thread** (the code comments
carry the original limit of 8 and a temporary reduction citing Papers issue 107)
([libview/pps-job-scheduler.c:87-106](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.c)).
So rasters run off the GTK main thread, one at a time; the view thread only
allocates and snapshots.

**Concurrency per page.** Each cache slot holds at most one running job plus
one pending job. If a slot already has a running job, `add_job_if_needed`
returns without queueing anything
([libview/pps-pixbuf-cache.c:694-730](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c));
if a new request arrives while one is pending, the pending job is cancelled and
replaced (latest request wins)
([libview/pps-pixbuf-cache.c:677-692](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
When a job completes, any pending job for that slot is promoted into the queue
([libview/pps-pixbuf-cache.c:306-310](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).

**What stops pointless work.** Five mechanisms, all in Papers:

1. Range refresh is coalesced through allocation, not scroll events: the
   adjustment's `value-changed` handler queues an allocate
   ([libview/pps-view.c:827-832](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)),
   and `pps_view_size_allocate` recomputes the visible range once per allocate
   ([libview/pps-view.c:3463-3486](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
2. `pps_pixbuf_cache_update_range` early-returns when the range and preload
   size did not change
   ([libview/pps-pixbuf-cache.c:490-493](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
3. A slot that already has a job is left alone, and a texture that already
   matches the required pixel size, device scale, and annotation flags never
   gets a new job
   ([libview/pps-pixbuf-cache.c:706-719](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
4. Stale results are discarded at completion: a finished job whose page left
   `[start - preload, end + preload]` is silently dropped and its texture never
   installed ([libview/pps-pixbuf-cache.c:282-311](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
   A zoom that changes the target size cancels now-invalid jobs
   ([libview/pps-pixbuf-cache.c:316-342](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c),
   [libview/pps-pixbuf-cache.c:599-613](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
5. Cancellation is cooperative and cheap: the worker checks the cancellable
   before starting a job
   ([libview/pps-job-scheduler.c:66-77](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.c)),
   `pps_job_cancel` is documented as main-thread-only
   ([libview/pps-job.c:174-203](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job.c)),
   and a render already running finishes its raster: the render job re-checks
   the cancellable only after the page is rasterized, to free the thread ASAP
   ([libview/pps-jobs.c:417-424](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-jobs.c)).
   Nothing polls the cancellable inside the poppler render path (verified by
   grep over `libdocument/`).

**Completion hand-off.** A finished job posts its signal to the main loop with
`g_idle_add_once`, and a cancelled job emits nothing
([libview/pps-job.c:124-156](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job.c)).
The texture is built inside the worker
([libview/pps-jobs.c:370-415](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-jobs.c)),
so the view thread never rasters.

**Visible work always runs.** Priority is the answer to fast scrolling, not
deferral: the visible range is queued `URGENT` and documented as always
rendered, while only preload work is `LOW`
([libview/pps-view.c:6379-6380](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c),
[libview/pps-job-scheduler.h:22-25](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.h)).

## Progressive quality

**There is no low-resolution first pass.** A page raster job is created once,
at the final size: `add_job` builds `pps_job_render_texture_new(document, page,
rotation, scale * device_scale, ceil(width * device_scale),
ceil(height * device_scale), ...)`
([libview/pps-pixbuf-cache.c:629-655](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
A grep for `lowres`, `low_res`, `preview_scale`, `half_scale` across `libview/`
and `libdocument/` at this commit returns nothing. Partial/tile refinement does
not exist either: `CacheJobInfo.region` is stored
([libview/pps-pixbuf-cache.c:17-18](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c),
[libview/pps-pixbuf-cache.c:645-647](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c))
but is never passed to `pps_job_render_texture_new`, and
`pps_pixbuf_cache_reload_page` still requests a whole-page render
([libview/pps-pixbuf-cache.c:1324-1345](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
The PDF backend rasterizes a full `cairo_image_surface` in one call
(`pdf_page_render`,
[libdocument/backend/pdf/pps-poppler.c:396-430](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libdocument/backend/pdf/pps-poppler.c)).

**Refinement happens across scale changes, and the old raster stays on screen.**
When the scale changes, jobs that no longer match the target size are cancelled
but their textures are not touched
([libview/pps-pixbuf-cache.c:316-342](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c));
for a visible slot the stale-size texture is only freed when the slot is a
non-visible (`LOW`) one
([libview/pps-pixbuf-cache.c:713-725](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
The snapshot then draws that old texture stretched into the current page rect,
using `GSK_SCALING_FILTER_NEAREST` only when the texture height already equals
the physical area height
([libview/pps-view-page.c:489-525](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)).
This is the smooth-zoom behavior `docs/PDF-VIEW.md` already specifies.

**The swap has no blank frame because the slot never lacks both textures.**
When a job finishes on the worker, the main-loop idle callback runs
`copy_job_to_job_info`, which replaces `job_info->texture` with one
`g_set_object` and marks the slot ready
([libview/pps-pixbuf-cache.c:251-280](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)),
then emits `job-finished`
([libview/pps-pixbuf-cache.c:303-304](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)),
and only then does the page widget ask for a redraw
([libview/pps-view-page.c:680-691](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)).
The old texture is dropped inside the same call that installs the new one, so
no frame observes a slot with neither.

**One dead field.** `PpsJobRenderTexture.page_ready`
([libview/pps-jobs.h:76](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-jobs.h))
has no assignment anywhere in the tree (verified by grep over all `.c` and
`.h` files), so the early-swap branch that reads it in
`pps_pixbuf_cache_get_texture` cannot fire at this commit
([libview/pps-pixbuf-cache.c:854-875](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)).
Textures therefore install only through the finished-idle path above.

## What the user sees before a page renders

**A white (or black, when inverted) paper rect, never a hole.** Two facts
combine:

1. GTK4 paints the widget's CSS background and border _before_ calling the
   widget's own `snapshot` vfunc: `gtk_widget_create_render_node` runs
   `gtk_css_style_snapshot_background` and `gtk_css_style_snapshot_border`,
   and only then `klass->snapshot`
   ([gtkwidget.c:12146-12235](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c),
   background at [gtkwidget.c:12217-12218](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).
2. The stylesheet gives the page node that background:
   `pps-view .document-page { background-color: white; }` and
   `pps-view .document-page.inverted { background-color: black; }`
   ([shell/resources/papers.css:75-82](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/shell/resources/papers.css)).

`pps_view_page_snapshot` returns early when the cache has no texture for the
page, drawing no content and skipping its children
([libview/pps-view-page.c:543-551](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)),
but the CSS background is already in the render node. The widget is also
clipped to its box (`overflow: hidden` set in `pps_view_page_new`,
[libview/pps-view-page.c:1575-1582](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)),
and it is allocated to the exact page extents each allocate
([libview/pps-view.c:3496-3517](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
So the placeholder is a correctly sized paper-colored page, which reads as a
page that has not printed yet rather than a missing surface.

**Previous frames survive scrolling.** Because textures are keyed by page in
the cache and retained across the visible-plus-preload window (see lifecycle
section), scrolling back within that window repaints from the retained texture
immediately. Only pages beyond the window fall back to the paper placeholder
until their `URGENT` re-render completes. Nothing ever shows the window
background in a page rect.

## Scroll-time compositing costs

**Scrolling triggers no raster.** Scroll events only queue an allocate
([libview/pps-view.c:827-832](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c));
the allocate moves page widgets and refreshes the cache range, which queues
jobs only for slots that lack a matching texture. The snapshot path reads the
cached `GdkTexture` (`pps_pixbuf_cache_get_texture` in
[libview/pps-view-page.c:527-590](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)),
so a frame costs a texture sample, never a document raster.

**Position-only moves reuse the page's cached render node.** GTK4 stores a
widget's position as a transform in `gtk_widget_allocate`; when only the
transform changed it queues a draw on the _parent_, and when the size changed
it queues the draw on the widget itself
([gtkwidget.c:4180-4400](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c),
size case at [gtkwidget.c:4394-4396](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c),
transform case at [gtkwidget.c:4399-4400](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).
`gtk_widget_do_snapshot` returns immediately when `draw_needed` is clear,
keeping the widget's previous render node, and `gtk_widget_snapshot_child`
re-appends that node with the new transform
([gtkwidget.c:12249-12296](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c),
[gtkwidget.c:12629-12670](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).
Since scrolling keeps page sizes constant, page content nodes are not rebuilt
during a scroll; only the view's node is.

**Off-screen pages cost nothing per frame.** Pages whose rect does not
intersect the viewport are unmarked child-visible
([libview/pps-view.c:3496-3517](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)),
which unmaps them in GTK
([gtkwidget.c:7052-7091](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c))
and skips them in `gtk_widget_snapshot_child`
([gtkwidget.c:12637-12648](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).

**Invalidation granularity is one widget.** When a raster lands, only the page
that owns it calls `gtk_widget_queue_draw`
([libview/pps-view-page.c:687-691](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c));
`gtk_widget_queue_draw` marks `draw_needed` up the ancestor chain and clears
only those cached nodes
([gtkwidget.c:3654-3681](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkwidget.c)).
Papers does no damage tracking of its own; that is GTK/GSK's job.

**Pixel-alignment hygiene.** The snapshot snaps the texture to a physical pixel
(`GSK_RECT_SNAP_ROUND`, with a manual sub-pixel correction fallback on older
GTK) and scales by the inverse fractional device scale
([libview/pps-view-page.c:564-588](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)),
using nearest filtering when the texture already matches the destination size
([libview/pps-view-page.c:495-521](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view-page.c)).
Combined with integer page sizing (`docs/PDF-VIEW.md`), page edges stay stable
through scroll and zoom.

## Wheel scroll speed limiting

Verdict first: **no speed-limiting mechanism exists** for wheel scrolling in
the continuous view, neither in Papers nor in GTK. The observed ceiling is
explained by per-notch quantization (each wheel event moves one fixed pixel
step) combined with the event rate the input device and GDK deliver. The
scrollbar-drag path is confirmed to be direct positioning with only a range
clamp, so it is uncapped by anything except pointer speed.

### Where a wheel event goes in continuous mode

Papers installs three scroll controllers on the view, and none of them does
delta math for a plain wheel in continuous mode:

1. A vertical `EventControllerScroll` whose handler is `scroll_to_zoom_cb`; it
   acts only while Ctrl is held and returns `FALSE` otherwise, so plain wheel
   events propagate
   ([libview/pps-view.blp:24-27](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.blp),
   [libview/pps-view.c:3547-3578](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
2. A capture-phase `Gtk.EventControllerScroll` with `kinetic | both_axes` whose
   handler is `page_scroll_cb`; it returns `GDK_EVENT_PROPAGATE` immediately
   when the model is continuous, so in continuous mode it never touches the
   adjustment. Its own stepping logic (accumulate deltas, require
   `distance >= 1` after dividing surface-unit distances by 50) applies only to
   the non-continuous page-by-page mode
   ([libview/pps-view.blp:77-82](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.blp),
   [libview/pps-view.c:5706-5787](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c),
   propagate at [libview/pps-view.c:5724-5725](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c),
   thresholds at [libview/pps-view.c:5737-5773](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
3. The `GtkScrolledWindow` around the view does the actual scrolling; the view
   is its scrollable child and its adjustments come from there
   ([shell/resources/pps-document-view.blp:518-521](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/shell/resources/pps-document-view.blp),
   adjustment wiring at [libview/pps-view.c:800-837](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).

The only Papers-side stepping code is keyboard/programmatic scrolling
(`pps_view_scroll`, which moves by the adjustment's `step_increment`,
`step_increment / 10`, or a page increment) and it is not on the wheel path
([libview/pps-view.c:1019-1145](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).
Papers' own scroll handling then only feeds the same pipeline as before:
`value-changed` queues an allocate
([libview/pps-view.c:827-832](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)).

### What GTK does per wheel event

`scrolled_window_scroll` applies one fixed multiplication and a range clamp,
nothing else: `new_value = unclamped_value + delta`, where the delta is scaled
by `get_wheel_detent_scroll_step` for `GDK_SCROLL_UNIT_WHEEL` events and by
`MAGIC_SCROLL_FACTOR` (2.5) for `GDK_SCROLL_UNIT_SURFACE` events
([gtkscrolledwindow.c:1364-1447](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c),
wheel branch [gtkscrolledwindow.c:1413-1435](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c),
factor [gtkscrolledwindow.c:201](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c)).
The wheel step is `scroll_step = pow (page_size, 2.0 / 3.0)` pixels per delta
unit, so a 1000 px tall viewport moves about 100 px per wheel delta
([gtkscrolledwindow.c:1206-1228](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c),
formula at [gtkscrolledwindow.c:1226](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c)).
The result is then clamped only to the adjustment range (with
`MAX_OVERSHOOT_DISTANCE` slack) in `_gtk_scrolled_window_set_adjustment_value`
([gtkscrolledwindow.c:3301-3326](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c)).
A search of `gtkscrolledwindow.c` for speed, velocity, limit, or clamp turns
up only this range clamping and the overshoot code; there is no px-per-ms
velocity clamp anywhere.

The window's scroll controllers are created with
`GTK_EVENT_CONTROLLER_SCROLL_BOTH_AXES | GTK_EVENT_CONTROLLER_SCROLL_KINETIC`
only; without the `DISCRETE` flag, GTK's integer-step accumulation and its
surface-to-wheel remapping never run for these controllers, so deltas are
applied as delivered
([gtkscrolledwindow.c:2214-2232](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c),
DISCRETE-only branches at [gtkeventcontrollerscroll.c:393-459](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkeventcontrollerscroll.c)).
The kinetic path is not a cap either: it only _adds_ a deceleration from an
initial velocity reported by the `decelerate` signal, itself scaled by the same
step formulas
([gtkscrolledwindow.c:1502-1545](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkscrolledwindow.c)),
and it is fed only from smooth-direction scroll sequences
([gtkeventcontrollerscroll.c:493-496](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkeventcontrollerscroll.c)).

### What actually bounds the observed speed

The wheel moves in quantized jumps of `pow(page_size, 2/3)` px times the
device's per-event delta, so perceived velocity is `step x event rate`. Both
factors sit below the application layer:

- GDK X11 computes the delta linearly as `(valuator_value - last_value) /
increment` with no clamp
  ([gdk/x11/gdkdevice-xi2.c:722-760](https://raw.githubusercontent.com/GNOME/gtk/main/gdk/x11/gdkdevice-xi2.c)).
- GDK compresses queued scroll events by summing their deltas into one event
  per batch, which preserves total distance and therefore does not cap speed;
  discrete-direction events break the merge run
  ([gdk/gdkevents.c:608-724](https://raw.githubusercontent.com/GNOME/gtk/main/gdk/gdkevents.c),
  break at [gdk/gdkevents.c:630](https://raw.githubusercontent.com/GNOME/gtk/main/gdk/gdkevents.c)).

So hypothesis 1 as stated (an application-level velocity cap) is **not
supported** by these sources. What is supported: motion is quantized into
fixed per-notch steps, the ceiling comes from how fast the device and GDK
emit events, and between events the view sits still so the coalesced
allocate-plus-`URGENT` pipeline described earlier has whole frames in which to
paint page content. That combination is consistent with "capped, and content
still visible while scrolling" without any code that says "slow down".

### Scrollbar drag: uncapped, confirmed

Dragging the scrollbar is pointer-position mapping, not incremental stepping.
`GtkRange` (the class behind `GtkScrollbar`) connects a drag gesture
([gtkrange.c:592-600](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkrange.c));
each update maps the pointer to a value (`new_value = coord_to_value (range,
c)`) and emits `change-value` with `GTK_SCROLL_JUMP`
([gtkrange.c:2446-2467](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkrange.c),
[gtkrange.c:2206-2224](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkrange.c));
`gtk_range_set_value` forwards to the adjustment
([gtkrange.c:1135-1159](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkrange.c)),
which clamps only to `[lower, upper - page_size]`
([gtkadjustment.c:363-371](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkadjustment.c),
[gtkadjustment.c:545-556](https://raw.githubusercontent.com/GNOME/gtk/main/gtk/gtkadjustment.c)).
A single motion event can therefore move the scroll position by any number of
pixels: drag speed is bounded only by pointer motion, which is why it outruns
the wheel's fixed per-notch rate.

There is no render-mode switch tied to dragging anywhere in Papers: the pixbuf
cache contains no drag references at all, and the view's drag handlers are for
selection, annotations, and middle-click panning
(grep of `libview/pps-pixbuf-cache.c` for "drag" returns 0 matches;
[libview/pps-view.c:4273](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-view.c)
is middle-click drag release, not the scrollbar).
The white placeholders during a drag are an _interpretation_, consistent with
verified mechanisms rather than a stated Papers behavior: a fast drag sweeps
the visible window across many pages per frame, the single render worker
([libview/pps-job-scheduler.c:87-106](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-job-scheduler.c))
cannot fill them before the window moves on, finished rasters for pages already
passed are discarded as out of window
([libview/pps-pixbuf-cache.c:289-294](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c)),
and pages beyond the preload ring lost their textures (lifecycle section above).
Wheel scrolling at a bounded step rate advances the window slowly enough for
`URGENT` renders to land, so content stays visible.

No recommendation R10 was added: there is no Papers mechanism to port. If
TuxBooks wants the same feel, it needs its own bounded per-notch step, and that
would be new behavior rather than a port (see Unverified for the open GDK
questions that such a change would depend on).

## Unverified

Items touched during research that are not stated as findings above:

- GPU-side texture reuse: whether GDK uploads each `GdkTexture` to the GPU only
  once and GSK reuses it across frames was not verified; GDK/GSK internals were
  not read. The compositing claims above stop at the GTK widget layer.
- Queue order among equal-priority `LOW` jobs: the scroll-direction preload
  ordering ([libview/pps-pixbuf-cache.c:791-797](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c))
  assumes `GThreadPool` preserves push order at equal priority. GLib docs were
  not consulted, so FIFO among equals is assumed, not proven.
- The reason for the 1-thread pool: only the in-code comment citing Papers
  issue 107 was read; the issue itself was not fetched.
- Evince: not consulted. Papers answered all five questions directly, so this
  note makes no Evince claims at all.
- The dead `page_ready` branch: confirmed dead at the pinned commit by grep;
  whether it was live in earlier revisions was not investigated. The
  suspicious `g_signal_emit(..., job_info->region)` in that same dead branch
  ([libview/pps-pixbuf-cache.c:867-872](https://raw.githubusercontent.com/GNOME/papers/dd693ee21726fdc08b135183e104b67c0e59b332/libview/pps-pixbuf-cache.c))
  was not investigated further.
- Mid-scroll style changes (color mode, theme) and their interaction with the
  render-node reuse path were not traced end to end.
- Wheel event details per backend: the exact `GdkScrollEvent` a mouse wheel
  produces (direction, unit, delta magnitude per detent) was not verified.
  `gdk_scroll_event_get_deltas` documents that deltas are zero unless the
  direction is `GDK_SCROLL_SMOOTH` (`gdk/gdkevents.c:2539-2543`), while the
  scrolled window multiplies by the wheel step only when the unit is
  `GDK_SCROLL_UNIT_WHEEL`; how a backend reconciles the two (and what
  `increment` X11 valuators use in `gdk/x11/gdkdevice-xi2.c:745`) was not
  traced. The Wayland wheel path could not be located: the fetched
  `gdk/wayland/gdkdevice-wayland.c` contains no scroll code, and the file that
  does was not identified.
- Whether the input layer rate-limits wheel events: not verified. The
  "observed ceiling" explanation rests on the absence of any clamp in Papers
  and GTK, plus the fixed per-notch step, not on a measured device-side rate
  limit.
- Whether a mouse wheel ever reaches GTK's kinetic deceleration path, and
  whether GDK's scroll compression (`gdk/gdkevents.c:608`) applies to wheel
  events, both depend on the unresolved direction question above.
- The two observed behaviors (capped wheel speed with visible content, white
  placeholders during drag) were reported by the user and not reproduced or
  timed here; the verdicts in this note come from reading the sources.

## Recommendations for TuxBooks

These are **proposals, not facts**, derived from the Papers sources named with
each one. Each names the TuxBooks component it would change.

**R1. Never defer a raster for a page inside the render window; make the
fast-scroll gate order work instead of blocking it.** Papers states that the
cache budget "doesn't affect the current visible page range, which will always
be rendered" (`pps-view.c:6379-6380`) and queues visible slots `URGENT` while
preload slots are `LOW` (`pps-pixbuf-cache.c:376-390`, `742-788`,
`pps-job-scheduler.h:22-25`). Component: the rejected fast-scroll gate in
`PdfReader` (with `pdfRenderPolicy`): replace "defer all new rasters while
scroll velocity is high" with "rasters for pages intersecting the render window
are always queued; only off-window/preload rasters are gated or reordered".
This is the direct answer to the blank stretches and pop-in the rejection
reported.

**R2. One running render plus one superseding pending render per page, latest
request wins.** Papers' `add_job` cancels and replaces a pending job and
`add_job_if_needed` does nothing while a job exists (`pps-pixbuf-cache.c:677-692`,
`706-719`). Component: `pdfiumWorker` cancel semantics plus the `PdfReader`
render window: at most one in-flight PDFium render per page, one queued
replacement, and replacing it cancels the queued one instead of stacking work.

**R3. Keep rendered bitmaps for pages just outside the window instead of
evicting to nothing.** Papers retains the visible range plus up to
`MAX_PRELOADED_PAGES 3` pages each side under a byte budget
(`pps-pixbuf-cache.c:105`, `416-469`, `347-400`) with a 50 MB default
(`pps-view.c:97`). Component: `pdfBitmapCache` (retain buffers for visible plus
a small preload ring per side, byte-bounded; `PERF-3`/`PERF-4` still govern) and
`PdfPageCanvas` (keep the canvas or its last bitmap presented for pages in that
extended window so scroll-back repaints instantly).

**R4. Paint a paper-colored page box behind the canvas.** Papers gets its
"never a hole" placeholder from CSS painted before the widget snapshot
(`papers.css:75-82` with GTK `gtkwidget.c:12217-12218`) while the page widget
draws nothing when no texture exists (`pps-view-page.c:543-551`). Component:
`PdfPageCanvas` / the `PdfReader` page container: give the page box the paper
color for the current color mode (white, black when inverted) behind the
canvas. Unrendered regions then read as unprinted paper, which removes the
blank-stretch symptom even before R1-R3 land.

**R5. Cancel and discard stale work instead of pausing all work.** Papers
cancels a slot's job when the slot leaves the window, replaces pending jobs,
kills wrong-size jobs after a zoom, and silently discards finished jobs outside
the window (`pps-pixbuf-cache.c:165-175`, `282-311`, `316-342`; worker skips
already-cancelled jobs `pps-job-scheduler.c:66-77`). Component:
`pdfiumWorker` cancel semantics (cancel queued renders when superseded; a
completed result that no longer matches the current window or scale is dropped
before it reaches the cache) plus `pdfBitmapCache` (never store
stale-window/stale-scale buffers).

**R6. Recompute the render window once per coalesced frame, not per scroll
event.** Papers routes scroll through `value-changed` to a queued allocate
(`pps-view.c:827-832`) and early-returns when the range did not change
(`pps-pixbuf-cache.c:490-493`). Component: `PdfReader` render window /
`usePdfScrollTracking` (keep the existing rAF coalescing and `PERF-5` commit
discipline; this recommendation is a keep-and-cite, not a change).

**R7. A scroll must only move pages, never re-raster them.** In GTK a
position-only allocation reuses the child's cached render node and invalidates
only the parent (`gtkwidget.c:4394-4400`, `12249-12296`); Papers' snapshot
reads a cached texture (`pps-view-page.c:548`). Component: `PdfPageCanvas` and
the `PdfReader` render window as a review rule: scroll offset may change
layout position only; raster keys stay scale, region, and eviction state, never
scroll position.

**R8. Keep raster concurrency small and spend the budget on ordering.** Papers
runs a single priority-sorted worker thread and promotes visible work to the
front of the queue (`pps-job-scheduler.c:87-114`, `139-149`), queueing preload
jobs in the scroll direction (`pps-pixbuf-cache.c:791-797`). Component:
`PdfReader` render-window constants (`MAX_CONCURRENT_RENDERS`) and
`pdfiumWorker` queue: prefer 1-2 concurrent rasters with visible-first
promotion and direction-ordered preload over many concurrent rasters, so a
fast scroll gets the page under the viewport first.

**R9. Size policy prior art (already covered by existing budgets).** Papers
caps zoom so one largest-page RGBA buffer fits the cache budget
(`pps-view.c:5651-5676`). Component: none required; `pdfRenderPolicy`'s
`PERF-1` two-tier cap already plays this role, and this citation is offered as
the Papers justification if those caps are ever revisited.
