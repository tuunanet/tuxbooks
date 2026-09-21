import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adjustmentUpper,
  adjustmentValueForPolicy,
  anchorAtOffset,
  centerValue,
  displayedSizes,
  keepPositionValue,
  layoutSlots,
  offsetForAnchor,
  PAGE_GAP_PX,
  viewportPointToDocumentPoint,
  type LayoutSlot,
  type ScrollAdjustment,
} from "@/components/reader/pdf/pdfLayout";

/**
 * The committed native oracle (oracle/expected/geometry.json, schema
 * tuxbooks.papers-oracle/2) drives the real Papers `PpsView` through a
 * fit-width start and a four-in/three-out zoom sweep. Its `zoom_script`
 * records the `GtkAdjustment` triple before and after each step, the document
 * point held at the viewport centre, and that point's drift. These tests
 * replay `pps_view_update_adjustment_value` against that script.
 */
interface OracleAdjustment {
  value: number;
  upper: number;
  page_size: number;
}

interface OracleZoomStep {
  action: string;
  factor: number;
  scale: number;
  hadjustment: OracleAdjustment;
  vadjustment: OracleAdjustment;
  center_anchor: { page: number; x: number; y: number };
  anchor_error: { dx: number; dy: number };
}

interface OracleDocument {
  name: string;
  page_doc_sizes: { index: number; width: number; height: number }[];
  zoom_script: OracleZoomStep[];
}

interface OracleGeometry {
  schema: string;
  viewport: { width: number; height: number };
  spacing: number;
  documents: OracleDocument[];
}

const ORACLE: OracleGeometry = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "..", "oracle", "expected", "geometry.json"), "utf8"),
) as OracleGeometry;

function asAdjustment(source: OracleAdjustment): ScrollAdjustment {
  return { value: source.value, upper: source.upper, pageSize: source.page_size };
}

/** The oracle's pages stacked at `scale`, in the reader's slot coordinates. */
function slotsAt(doc: OracleDocument, scale: number): LayoutSlot[] {
  return layoutSlots(
    displayedSizes(
      doc.page_doc_sizes.map((size) => ({
        pageNumber: size.index + 1,
        width: size.width,
        height: size.height,
      })),
      scale,
    ),
    PAGE_GAP_PX,
  );
}

describe("adjustmentUpper", () => {
  it("is the padded content size, never below the viewport (Papers MAX)", () => {
    expect(adjustmentUpper(768, 1318)).toBe(1318);
    expect(adjustmentUpper(1024, 600)).toBe(1024);
    expect(adjustmentUpper(768, 768)).toBe(768);
  });
});

describe("keepPositionValue", () => {
  it("preserves the old relative offset on the new content", () => {
    // value / upper = 0.5, reapplied to a 2000px content.
    const next = keepPositionValue({ value: 500, upper: 1000, pageSize: 400 }, 2000, 400);
    expect(next).toBe(1000);
    expect(next / 2000).toBeCloseTo(500 / 1000, 12);
  });

  it("clamps onto the new scroll range", () => {
    // The old offset near the bottom must not overflow the new content.
    expect(keepPositionValue({ value: 950, upper: 1000, pageSize: 400 }, 500, 400)).toBe(100);
    expect(keepPositionValue({ value: 0, upper: 1000, pageSize: 400 }, 2000, 400)).toBe(0);
  });

  it("keeps the top of the document at the top", () => {
    expect(keepPositionValue({ value: 0, upper: 1318, pageSize: 768 }, 1577, 768)).toBe(0);
  });
});

describe("centerValue", () => {
  it("holds the point under the pointer across the scale change", () => {
    const adjustment: ScrollAdjustment = { value: 0, upper: 1318, pageSize: 768 };
    const next = centerValue(adjustment, 1577, 768, 200);
    const before = viewportPointToDocumentPoint(adjustment.value, 200, ORACLE.spacing, 1.633986928);
    const after = viewportPointToDocumentPoint(next, 200, ORACLE.spacing, 1.960784314);
    // Papers' own rounding leaves sub-point drift; the point stays fixed.
    expect(Math.abs(after - before)).toBeLessThan(1);
  });

  it("falls back to the viewport centre for a negative zoom centre", () => {
    const adjustment: ScrollAdjustment = { value: 0, upper: 1024, pageSize: 1024 };
    expect(centerValue(adjustment, 1224, 1024)).toBe(centerValue(adjustment, 1224, 1024, 512));
    expect(centerValue(adjustment, 1224, 1024)).toBe(100);
  });

  it("clamps onto the new scroll range", () => {
    // The focal point wants a value beyond the bottom of the new range.
    expect(centerValue({ value: 900, upper: 1000, pageSize: 500 }, 1000, 500, 0)).toBe(500);
    // A pointer below the anchor pulls the value above the top.
    expect(centerValue({ value: 0, upper: 1000, pageSize: 500 }, 1000, 500, 800)).toBe(0);
  });
});

describe("adjustmentValueForPolicy", () => {
  const adjustment: ScrollAdjustment = { value: 0, upper: 1318, pageSize: 768 };

  it("dispatches to keep-position or center", () => {
    expect(adjustmentValueForPolicy("keep-position", adjustment, 1577, 768, 384)).toBe(0);
    expect(adjustmentValueForPolicy("center", adjustment, 1577, 768, 384)).toBeCloseTo(
      75.459787557,
      8,
    );
  });
});

describe("viewportPointToDocumentPoint", () => {
  it("maps a viewport position to a page-local point", () => {
    // Single-page free step: (0 + 384 - 12) / 1.633986928 = 227.664.
    expect(viewportPointToDocumentPoint(0, 384, 12, 1.633986928)).toBeCloseTo(227.664, 3);
  });

  it("returns 0 for an unmeasurable scale", () => {
    expect(viewportPointToDocumentPoint(100, 100, 0, 0)).toBe(0);
  });
});

describe("anchorAtOffset / offsetForAnchor", () => {
  const slots: LayoutSlot[] = [
    { pageNumber: 1, top: 0, width: 600, height: 800 },
    { pageNumber: 2, top: 808, width: 600, height: 800 },
  ];

  it("round-trips a document anchor", () => {
    const anchor = anchorAtOffset(1200, slots);
    expect(anchor).toEqual({ page: 2, fraction: 0.49 });
    expect(offsetForAnchor(anchor as { page: number; fraction: number }, slots)).toBeCloseTo(
      1200,
      12,
    );
  });

  it("clamps the fraction inside a page and handles empty slots", () => {
    // Above the first page top the offset is clamped into page 1, matching
    // pageAtOffset; an unknown page has no offset.
    expect(anchorAtOffset(-50, slots)).toEqual({ page: 1, fraction: 0 });
    expect(anchorAtOffset(0, [])).toBeNull();
    expect(offsetForAnchor({ page: 9, fraction: 0 }, slots)).toBeNull();
  });
});

describe("Papers fidelity oracle: focal zoom and scroll policies", () => {
  it("carries the expected schema and fixtures", () => {
    expect(ORACLE.schema).toBe("tuxbooks.papers-oracle/2");
    expect(ORACLE.documents.length).toBe(7);
  });

  it("reproduces every zoom step's adjustment value on every fixture", () => {
    for (const doc of ORACLE.documents) {
      const steps = doc.zoom_script;
      for (let i = 1; i < steps.length; i++) {
        const previous = steps[i - 1] as OracleZoomStep;
        const step = steps[i] as OracleZoomStep;
        for (const axis of ["hadjustment", "vadjustment"] as const) {
          const old = asAdjustment(previous[axis]);
          const next = step[axis];
          // Papers' zoom anchor is the viewport centre for keyboard/scripted
          // steps: zoom_center = page_size * 0.5.
          const predicted = centerValue(old, next.upper, next.page_size, old.pageSize * 0.5);
          expect(predicted, `${doc.name} step ${i} ${axis}`).toBeCloseTo(next.value, 8);
        }
      }
    }
  });

  it("holds the anchor fixed within tolerance on every fixture", () => {
    for (const doc of ORACLE.documents) {
      const steps = doc.zoom_script;
      for (let i = 1; i < steps.length; i++) {
        const previous = steps[i - 1] as OracleZoomStep;
        const step = steps[i] as OracleZoomStep;
        const centerX = previous.hadjustment.page_size * 0.5;
        const centerY = previous.vadjustment.page_size * 0.5;

        const beforeX = viewportPointToDocumentPoint(
          previous.hadjustment.value,
          centerX,
          ORACLE.spacing,
          previous.scale,
        );
        const afterX = viewportPointToDocumentPoint(
          step.hadjustment.value,
          centerX,
          ORACLE.spacing,
          step.scale,
        );
        const beforeY = viewportPointToDocumentPoint(
          previous.vadjustment.value,
          centerY,
          ORACLE.spacing,
          previous.scale,
        );
        const afterY = viewportPointToDocumentPoint(
          step.vadjustment.value,
          centerY,
          ORACLE.spacing,
          step.scale,
        );

        // The derived document point is the oracle's recorded anchor, and its
        // drift across the step is the oracle's anchor_error (sub-point,
        // caused by integer page sizing).
        expect(afterX, `${doc.name} step ${i} x anchor`).toBeCloseTo(step.center_anchor.x, 6);
        expect(afterY, `${doc.name} step ${i} y anchor`).toBeCloseTo(step.center_anchor.y, 6);
        expect(Math.abs(afterX - beforeX), `${doc.name} step ${i} x drift`).toBeCloseTo(
          Math.abs(step.anchor_error.dx),
          6,
        );
        expect(Math.abs(afterY - beforeY), `${doc.name} step ${i} y drift`).toBeCloseTo(
          Math.abs(step.anchor_error.dy),
          6,
        );
        expect(Math.abs(afterX - beforeX), `${doc.name} step ${i} x tolerance`).toBeLessThan(1);
        expect(Math.abs(afterY - beforeY), `${doc.name} step ${i} y tolerance`).toBeLessThan(1);

        // The anchor names the same page the oracle records, resolved through
        // the reader's own slot math at the post-zoom scale.
        const slots = slotsAt(doc, step.scale);
        const anchor = anchorAtOffset(step.vadjustment.value + centerY, slots);
        expect(anchor?.page, `${doc.name} step ${i} anchor page`).toBe(step.center_anchor.page + 1);
      }
    }
  });

  it("holds an off-centre pointer point fixed on every fixture", () => {
    for (const doc of ORACLE.documents) {
      const free = doc.zoom_script[0] as OracleZoomStep;
      const zoomed = doc.zoom_script[1] as OracleZoomStep;
      // A pointer at 30% of the viewport, not the centre the scripted zoom
      // uses, must still land on the same page point after the transform.
      const pointerX = ORACLE.viewport.width * 0.3;
      const pointerY = ORACLE.viewport.height * 0.3;

      for (const [axis, pointer] of [
        ["hadjustment", pointerX],
        ["vadjustment", pointerY],
      ] as const) {
        const before = viewportPointToDocumentPoint(
          free[axis].value,
          pointer,
          ORACLE.spacing,
          free.scale,
        );
        const next = centerValue(
          asAdjustment(free[axis]),
          zoomed[axis].upper,
          zoomed[axis].page_size,
          pointer,
        );
        const after = viewportPointToDocumentPoint(next, pointer, ORACLE.spacing, zoomed.scale);
        // Integer page sizing bends the transform by up to ~1.2 points at an
        // off-centre pointer (the oracle's centre anchor stays under 1).
        expect(Math.abs(after - before), `${doc.name} ${axis} pointer`).toBeLessThan(1.5);
      }
    }
  });

  it("keeps the pointer point and a re-layout at different offsets", () => {
    // Top of the document: keep-position holds the top edge, while an
    // explicit pointer zoom pulls the point under the cursor into view.
    const adjustment: ScrollAdjustment = { value: 0, upper: 1318, pageSize: 768 };
    const kept = keepPositionValue(adjustment, 1577, 768);
    const centered = centerValue(adjustment, 1577, 768, 384);
    expect(kept).toBe(0);
    expect(centered).toBeCloseTo(75.459787557, 8);
    expect(kept).not.toBe(centered);
  });
});
