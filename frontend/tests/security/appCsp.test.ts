import { describe, expect, it } from "vitest";

import { APP_UI_CSP, appUiCsp } from "../../../electron/shared/appCsp";

/** Extract one directive's value list from a serialized policy ("" when absent). */
function directive(policy: string, name: string): string {
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    const [directiveName, ...values] = trimmed.split(/\s+/);
    if (directiveName === name) return values.join(" ");
  }
  return "";
}

describe("appUiCsp (X-2: strict CSP for the application UI)", () => {
  it("locks the default source down to none", () => {
    expect(directive(APP_UI_CSP, "default-src")).toBe("'none'");
  });

  it("allows self scripts and WASM, the toolkit's blob: section scripts, but no inline or eval execution", () => {
    const scriptSrc = directive(APP_UI_CSP, "script-src");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).toContain("blob:");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("grants the reader frames' inline and blob: styles (inherited policy)", () => {
    const styleSrc = directive(APP_UI_CSP, "style-src");
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("blob:");
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("keeps publication resources fetchable from the app origin", () => {
    const connectSrc = directive(APP_UI_CSP, "connect-src");
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("tuxbooks:");
  });

  it("keeps the reader's sandboxed blob frames mountable", () => {
    expect(directive(APP_UI_CSP, "frame-src")).toContain("blob:");
    expect(directive(APP_UI_CSP, "worker-src")).toContain("'self'");
  });

  it("keeps covers and bundled images loadable", () => {
    const imgSrc = directive(APP_UI_CSP, "img-src");
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("tuxbooks:");
  });

  it("closes the active-content directives and scopes the base URI", () => {
    expect(directive(APP_UI_CSP, "object-src")).toBe("'none'");
    expect(directive(APP_UI_CSP, "form-action")).toBe("'none'");
    expect(directive(APP_UI_CSP, "base-uri")).toBe("'self' tuxbooks:");
  });

  it("keeps reader fonts and media loadable from the publication and blobs", () => {
    expect(directive(APP_UI_CSP, "font-src")).toContain("tuxbooks:");
    expect(directive(APP_UI_CSP, "font-src")).toContain("blob:");
    expect(directive(APP_UI_CSP, "media-src")).toContain("tuxbooks:");
  });

  it("relaxes only what the dev server needs (HMR preamble, style injection, ws)", () => {
    const dev = appUiCsp("development");
    expect(directive(dev, "script-src")).toContain("'unsafe-inline'");
    expect(directive(dev, "style-src")).toContain("'unsafe-inline'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(dev, "default-src")).toBe("'none'");
  });
});
