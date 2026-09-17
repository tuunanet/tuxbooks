/**
 * Hostile EPUB corpus builders (issue #87, E-1..E-5). Runtime-generated,
 * never committed as binaries; deterministic so a failing case reproduces
 * byte for byte. The vitest corpus tests consume these directly; the E2E
 * security spec keeps its own copy because e2e is a separate package and
 * cannot import from the frontend test tree.
 */

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
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
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

export interface HostileEpub {
  name: string;
  invariant: string;
  /** The chapter bytes the policy layer must fence. */
  chapter: string;
  bytes: Buffer;
}

const XHTML_PROLOG = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>`;

function xhtml(body: string): string {
  return `${XHTML_PROLOG}${body}</body></html>`;
}

function epub(title: string, chapter: string): Buffer {
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
  return buildZip([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "content.opf", data: opf },
    { name: "chapter1.xhtml", data: chapter },
  ]);
}

export const HOSTILE_EPUB_CORPUS: readonly HostileEpub[] = [
  {
    name: "hostile-scripted",
    invariant: "E-1",
    chapter: xhtml(`<p>text</p><script>alert(1)</script>`),
    bytes: epub("Hostile Scripted Book", xhtml(`<p>text</p><script>alert(1)</script>`)),
  },
  {
    name: "hostile-active",
    invariant: "E-2",
    chapter: xhtml(
      `<p>text</p><iframe src="page.xhtml"></iframe>` +
        `<object data="evil.swf" type="application/x-shockwave-flash"></object>` +
        `<embed src="evil.swf" type="application/x-shockwave-flash">`,
    ),
    bytes: epub(
      "Hostile Active Book",
      xhtml(
        `<p>text</p><iframe src="page.xhtml"></iframe>` +
          `<object data="evil.swf" type="application/x-shockwave-flash"></object>` +
          `<embed src="evil.swf" type="application/x-shockwave-flash">`,
      ),
    ),
  },
  {
    name: "hostile-external",
    invariant: "E-3",
    chapter: xhtml(
      `<p>text</p><img src="https://evil.example/track.png" alt="beacon" />` +
        `<link rel="stylesheet" href="https://evil.example/style.css" />`,
    ),
    bytes: epub(
      "Hostile External Book",
      xhtml(
        `<p>text</p><img src="https://evil.example/track.png" alt="beacon" />` +
          `<link rel="stylesheet" href="https://evil.example/style.css" />`,
      ),
    ),
  },
  {
    name: "hostile-path-probe",
    invariant: "E-4",
    chapter: xhtml(
      `<p>text</p><a href="file:///home/user/.ssh/id_rsa">probe</a>` +
        `<a href="tuxbooks://book/999/chapter1.xhtml">cross-book</a>`,
    ),
    bytes: epub(
      "Hostile Path Probe Book",
      xhtml(
        `<p>text</p><a href="file:///home/user/.ssh/id_rsa">probe</a>` +
          `<a href="tuxbooks://book/999/chapter1.xhtml">cross-book</a>`,
      ),
    ),
  },
  {
    name: "hostile-encoding",
    invariant: "E-1",
    chapter: `<?xml version="1.0" encoding="utf-7"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>text</p><div onload="alert(1)">x</div></body></html>`,
    bytes: epub(
      "Hostile Encoding Book",
      `<?xml version="1.0" encoding="utf-7"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>text</p><div onload="alert(1)">x</div></body></html>`,
    ),
  },
];
