import { makeBook } from "./factories";

export const epub = () =>
  makeBook({
    id: 1,
    addedAt: "2026-08-01T00:00:00.000Z",
    lastOpenedAt: "2026-08-05T00:00:00.000Z",
  });

export const pdf = () =>
  makeBook({
    id: 2,
    path: "/tmp/library/doc.pdf",
    format: "pdf",
    title: "PDF Book",
    addedAt: "2026-08-10T00:00:00.000Z",
    lastOpenedAt: "2026-08-20T00:00:00.000Z",
  });

export const neverOpened = () =>
  makeBook({ id: 3, addedAt: "2026-08-15T00:00:00.000Z", lastOpenedAt: null });
