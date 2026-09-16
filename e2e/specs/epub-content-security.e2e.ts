/**
 * EPUB content fencing smoke (issue #82, E-1..E-3). Own phase: it drops
 * runtime-generated hostile EPUBs into an otherwise empty scratch library,
 * which must not pollute the seeded suites' book counts.
 *
 * Unit tests cover the policy module (`frontend/tests/security/
 * contentPolicy.test.ts`) and the sidecar gates (`epub/session.rs`); this
 * spec proves the whole chain in the real app: a scripted book fails to
 * open, and a book that does open renders frames that are sanitized,
 * CSP-fenced, and silent on the network.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "../fixtures/electron-app.js";

import { libraryDir } from "../setup/environment.js";
import { returnToLibrary } from "./helpers.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Buffer {
  return Buffer.from([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

/** Minimal STORED-entry ZIP writer: hostile fixtures are built at runtime. */
function buildZip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const bytes = Buffer.from(data, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(bytes.length),
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      bytes,
    ]);
    const directory = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(bytes.length),
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    central.push(directory);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

function hostileEpub(title: string, chapterBody: string): Buffer {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:${title.toLowerCase().replace(/\s+/g, "-")}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  const container = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${chapterBody}</body></html>`;
  return buildZip([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "content.opf", data: opf },
    { name: "chapter1.xhtml", data: chapter },
  ]);
}

/** Every hostile chapter: an external beacon plus active markup, no <script>. */
const ACTIVE_BODY = `<p id="text">visible chapter text</p>
<img id="beacon" src="https://evil.example/track.png" alt="beacon" />
<a id="js" href="javascript:alert(1)">click</a>
<div id="handler" onclick="alert(1)">styled</div>
<iframe id="frame" src="https://evil.example/frame"></iframe>
<object id="obj" data="https://evil.example/x" type="text/html"></object>`;

interface FrameProbe {
  csp: string[];
  scripts: number;
  active: number;
  handlers: number;
  jsHrefs: number;
  hasText: boolean;
}

test.describe("epub content fencing (issue #82)", () => {
  test.beforeEach(async ({ page }) => {
    // The phase library starts empty: empty-library state first, the
    // library view mounts with the first imported book.
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
  });

  test("an opened hostile book renders sanitized, CSP-fenced frames", async ({ page }) => {
    // A CSP-blocked request can still surface as a `request` event with no
    // data exchanged; the invariant is that no external round trip completes.
    const externalResponses: string[] = [];
    page.on("response", (response) => {
      if (/^https?:/i.test(response.url())) externalResponses.push(response.url());
    });
    const externalFailures: { url: string; error: string }[] = [];
    page.on("requestfailed", (request) => {
      if (/^https?:/i.test(request.url())) {
        externalFailures.push({
          url: request.url(),
          error: request.failure()?.errorText ?? "unknown",
        });
      }
    });

    writeFileSync(
      path.join(libraryDir, "hostile-active.epub"),
      hostileEpub("Hostile Active Book", ACTIVE_BODY),
    );
    const card = page.locator('[aria-label="Hostile Active Book (EPUB)"]');
    await card.waitFor({ state: "visible", timeout: 30000 });

    await card.dblclick();
    await page.getByTestId("detail-continue").click();
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready", {
      timeout: 30000,
    });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const frame = document.querySelector(
              "[data-epub-host] iframe",
            ) as HTMLIFrameElement | null;
            const doc = frame?.contentDocument;
            if (!doc || !doc.body) return null;
            return {
              csp: Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'))
                .map((meta) => meta.getAttribute("content") ?? "")
                .filter((content) => content.includes("script-src")),
              // The toolkit's own injected scripts are marked data-readium
              // and are the only scripts a fenced frame may carry.
              scripts: Array.from(doc.querySelectorAll("script")).filter(
                (script) => !script.hasAttribute("data-readium"),
              ).length,
              active: doc.querySelectorAll("iframe, object, embed").length,
              handlers: doc.querySelectorAll("[onclick],[onerror],[onload]").length,
              jsHrefs: Array.from(doc.querySelectorAll("a")).filter((a) =>
                (a.getAttribute("href") ?? "").trim().toLowerCase().startsWith("javascript:"),
              ).length,
              hasText: (doc.body.textContent ?? "").includes("visible chapter text"),
            } satisfies FrameProbe;
          }),
        {
          timeout: 15000,
          message: "the section frame never mounted with readable text",
        },
      )
      .toEqual({
        csp: expect.arrayContaining([expect.stringContaining("script-src blob:")]),
        scripts: 0,
        active: 0,
        handlers: 0,
        jsHrefs: 0,
        hasText: true,
      });

    expect(externalResponses).toEqual([]);
    for (const failure of externalFailures) {
      expect(
        failure.error.toLowerCase(),
        `${failure.url} must be blocked by the frame CSP`,
      ).toContain("csp");
    }

    await returnToLibrary(page);
  });

  test("a scripted book never opens", async ({ page }) => {
    writeFileSync(
      path.join(libraryDir, "hostile-scripted.epub"),
      hostileEpub("Hostile Scripted Book", "<p>x</p><script>alert(1)</script>"),
    );
    const card = page.locator('[aria-label="Hostile Scripted Book (EPUB)"]');
    await card.waitFor({ state: "visible", timeout: 30000 });

    await card.dblclick();
    await page.getByTestId("detail-continue").click();
    await expect(page.getByTestId("epub-error")).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-epub-state="ready"]')).toHaveCount(0);

    await returnToLibrary(page);
  });
});
