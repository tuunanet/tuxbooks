import type { Book, ReadingProgress } from "@/types/domain";

/**
 * A book fixture plus optional reading progress. Progress has no backend
 * command yet, so it exists only in fixtures/tests until
 * `get_reading_progress` / `save_reading_progress` are wired up.
 */
export type FixtureBook = Book & { progress?: ReadingProgress };

/**
 * Realistic, original sample data so the UI can be evaluated visually.
 * Dates are staggered to exercise "Recently Added" / "Recently Read" ordering.
 */
export const fixtureBooks: FixtureBook[] = [
  {
    id: 1,
    path: "/library/the-quiet-meridian.epub",
    format: "epub",
    title: "The Quiet Meridian",
    subtitle: "Notes from the Long Coast",
    author: "Elena Vasquez",
    publisher: "Harborlight Press",
    language: "en",
    isbn: "978-0-00-000001-1",
    description:
      "A season of tide charts, radio static, and the slow repair of a family held together by distance.",
    coverPath: null,
    addedAt: "2026-08-12T09:15:00.000Z",
    modifiedAt: "2026-08-12T09:15:00.000Z",
    lastOpenedAt: "2026-08-28T20:42:00.000Z",
    progress: { kind: "epub", cfi: "epubcfi(/6/14!/4/2/16)", percentage: 78 },
  },
  {
    id: 2,
    path: "/library/systems-of-arrangement.pdf",
    format: "pdf",
    title: "Systems of Arrangement",
    subtitle: null,
    author: "Tomas Lindqvist",
    publisher: "Northlight Academic",
    language: "en",
    isbn: "978-0-00-000002-2",
    description:
      "How libraries, herbaria, and archives impose order on abundance without losing the individual object.",
    coverPath: null,
    addedAt: "2026-08-10T14:00:00.000Z",
    modifiedAt: "2026-08-10T14:00:00.000Z",
    lastOpenedAt: null,
  },
  {
    id: 3,
    path: "/library/cartography-of-sleep.epub",
    format: "epub",
    title: "Cartography of Sleep",
    subtitle: null,
    author: "Amara Diallo",
    publisher: "Harborlight Press",
    language: "en",
    isbn: "978-0-00-000003-3",
    description:
      "An atlas of night: dreams recorded across three generations of one migrating family.",
    coverPath: null,
    addedAt: "2026-07-30T18:30:00.000Z",
    modifiedAt: "2026-07-30T18:30:00.000Z",
    lastOpenedAt: "2026-08-27T22:10:00.000Z",
    progress: { kind: "epub", cfi: "epubcfi(/6/4!/4/2)", percentage: 12 },
  },
  {
    id: 4,
    path: "/library/the-lantern-archive.epub",
    format: "epub",
    title: "The Lantern Archive",
    subtitle: null,
    author: "Hana Sato",
    publisher: "Foxglove & Co.",
    language: "en",
    isbn: "978-0-00-000004-4",
    description:
      "A lighthouse keeper inherits a cellar of unsent letters and answers them, one storm at a time.",
    coverPath: null,
    addedAt: "2026-07-21T11:05:00.000Z",
    modifiedAt: "2026-07-21T11:05:00.000Z",
    lastOpenedAt: "2026-08-25T07:55:00.000Z",
    progress: { kind: "epub", cfi: "epubcfi(/6/26!/4)", percentage: 100 },
  },
  {
    id: 5,
    path: "/library/field-notes-on-silence.pdf",
    format: "pdf",
    title: "Field Notes on Silence",
    subtitle: "Essays on Sound and Absence",
    author: "Petter Moen",
    publisher: "Northlight Academic",
    language: "en",
    isbn: "978-0-00-000005-5",
    description:
      "Nine essays on the places sound abandons: anechoic rooms, empty theatres, off-season resorts.",
    coverPath: null,
    addedAt: "2026-07-15T16:45:00.000Z",
    modifiedAt: "2026-07-15T16:45:00.000Z",
    lastOpenedAt: null,
  },
  {
    id: 6,
    path: "/library/a-grammar-of-rivers.epub",
    format: "epub",
    title: "A Grammar of Rivers",
    subtitle: null,
    author: "Sofia Marchetti",
    publisher: "Foxglove & Co.",
    language: "en",
    isbn: "978-0-00-000006-6",
    description:
      "A hydrologist and a poet trade notebooks for a year, mapping the same watershed in different languages.",
    coverPath: null,
    addedAt: "2026-06-28T08:20:00.000Z",
    modifiedAt: "2026-06-28T08:20:00.000Z",
    lastOpenedAt: null,
  },
  {
    id: 7,
    path: "/library/winter-arithmetic.pdf",
    format: "pdf",
    title: "Winter Arithmetic",
    subtitle: null,
    author: "Jonas Weber",
    publisher: "Small Hours Editions",
    language: "en",
    isbn: "978-0-00-000007-7",
    description:
      "A village accountant tallies what the cold takes and what it leaves behind, in columns that begin to rhyme.",
    coverPath: null,
    addedAt: "2026-06-12T13:10:00.000Z",
    modifiedAt: "2026-06-12T13:10:00.000Z",
    lastOpenedAt: "2026-08-20T19:30:00.000Z",
    progress: { kind: "pdf", page: 88, percentage: 45 },
  },
  {
    id: 8,
    path: "/library/the-cartographers-apprentice.epub",
    format: "epub",
    title: "The Cartographer's Apprentice",
    subtitle: null,
    author: "Priya Raman",
    publisher: "Small Hours Editions",
    language: "en",
    isbn: "978-0-00-000008-8",
    description:
      "Mapped roads keep moving; the apprentice learns that a good map records what the mapmaker refuses to see.",
    coverPath: null,
    addedAt: "2026-05-30T10:00:00.000Z",
    modifiedAt: "2026-05-30T10:00:00.000Z",
    lastOpenedAt: null,
  },
];
