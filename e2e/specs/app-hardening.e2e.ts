/**
 * Electron hardening verification (issue #85, X-1..X-5): the renderer
 * isolation flags, the app UI CSP, navigation fencing, deny-by-default
 * permissions, and the validated external-link seam, proven in the real app
 * on the production load path (`app://bundle`, never the dev server).
 *
 * The policy logic itself is unit-pinned in `frontend/tests/security/`
 * (windowSecurity, appCsp, linkPolicy); this spec proves the whole chain
 * live: what the renderer can reach, what the session grants, and what a
 * navigation attempt from the page can do.
 */
import { expect, test } from "../fixtures/electron-app.js";

interface IsolationProbe {
  require: string;
  process: string;
  module: string;
  bridge: string;
  invoke: string;
}

test.describe("app hardening (issue #85, X-1..X-5)", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
  });

  test("X-1: the renderer sees no Node.js and only the enumerated bridge", async ({ page }) => {
    const probe = await page.evaluate((): IsolationProbe => {
      const env = window as unknown as Record<string, unknown>;
      const bridge = env.tuxbooks as { invoke?: unknown } | undefined;
      return {
        require: typeof env.require,
        process: typeof env.process,
        module: typeof env.module,
        bridge: typeof bridge,
        invoke: typeof bridge?.invoke,
      };
    });
    expect(probe).toEqual({
      require: "undefined",
      process: "undefined",
      module: "undefined",
      bridge: "object",
      invoke: "function",
    });

    // webSecurity on top of the isolation flags: local files are not
    // reachable from the app origin.
    const fileAccess = await page.evaluate(() =>
      fetch("file:///etc/hostname").then(
        () => "file-readable",
        (error: Error) => `file-blocked: ${error.message}`,
      ),
    );
    expect(fileAccess).toContain("file-blocked");
  });

  test("X-2: the app UI ships a strict CSP and enforces it", async ({ page }) => {
    const header = await page.evaluate(async () => {
      const response = await fetch("app://bundle/index.html");
      return response.headers.get("content-security-policy");
    });
    expect(header).toContain("default-src 'none'");
    expect(header).toContain("script-src 'self' 'wasm-unsafe-eval'");

    // CDP evaluation is CSP-exempt, so enforcement is probed the way the
    // page itself would be: an inline script element must not execute.
    const inline = await page.evaluate(async () => {
      const probe = document.createElement("script");
      probe.id = "csp-inline-probe";
      probe.textContent = "window.__cspInlineExecuted = true";
      document.head.appendChild(probe);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const env = window as unknown as { __cspInlineExecuted?: boolean };
      return env.__cspInlineExecuted === true ? "inline-executed" : "inline-blocked";
    });
    expect(inline).toBe("inline-blocked");

    // The external request must be refused. A blocked fetch rejects with a
    // generic network error, so the CSP's own console violation is the
    // evidence that the refusal came from the policy.
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content.security.policy/i.test(message.text())) violations.push(message.text());
    });
    const connect = await page.evaluate(() =>
      fetch("https://evil.example/beacon").then(
        () => "connect-allowed",
        () => "connect-refused",
      ),
    );
    expect(connect).toBe("connect-refused");
    expect(violations.join("\n")).toContain("connect-src");
  });

  test("X-4: permission requests are denied by default", async ({ page }) => {
    const notifications = await page.evaluate(async () => {
      if (typeof Notification === "undefined") return "no-notification-api";
      return Notification.requestPermission();
    });
    expect(notifications).toBe("denied");

    const queryState = await page.evaluate(async () => {
      const status = await navigator.permissions.query({ name: "notifications" as never });
      return status.state;
    });
    expect(queryState).toBe("denied");

    const media = await page.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        return "media-granted";
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(media).toBe("NotAllowedError");
  });

  test("X-4: the reader's own fullscreen request still works", async ({ page }) => {
    // A trusted keydown grants transient activation; the presentation-mode
    // path (ReaderShell requestFullscreen) relies on the same grant.
    await page.keyboard.press("Shift");
    const result = await page.evaluate(async () => {
      try {
        await document.documentElement.requestFullscreen();
        return document.fullscreenElement !== null ? "fullscreen-entered" : "fullscreen-missing";
      } catch (error) {
        return `fullscreen-rejected: ${(error as Error).name}`;
      } finally {
        void document.exitFullscreen().catch(() => {});
      }
    });
    expect(result).toBe("fullscreen-entered");
  });

  test("X-5: unsafe window.open targets spawn no window", async ({ page }) => {
    const opened = await page.evaluate(() => {
      const targets = [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<b>x</b>",
        "tuxbooks://book/1",
      ];
      return targets.map((target) => window.open(target) === null);
    });
    expect(opened).toEqual([true, true, true, true]);
  });

  test("X-3: the renderer cannot navigate the top frame away from the app origin", async ({
    page,
  }) => {
    // Renderer-initiated attempts are the threat path (will-navigate fires
    // for them and the policy prevents them). A blocked file:// attempt can
    // transiently show Chromium's error page, so the verdict is the settled
    // end state: the app document alive and back at the app origin. A real
    // takeover never returns to it, which is the failure we want.
    const appDocumentState = async (): Promise<{ href: string; shellAlive: boolean } | null> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const state = await page.evaluate(() => ({
            href: window.location.href,
            shellAlive: document.querySelector('[data-testid="app-shell"]') !== null,
          }));
          if (state.shellAlive && state.href === "app://bundle/index.html") return state;
        } catch {
          // Transient error-page context between documents; keep waiting.
        }
        await page.waitForTimeout(250);
      }
      return null;
    };

    for (const target of ["tuxbooks://book/1", "file:///etc/passwd", "data:text/html,<p>x</p>"]) {
      await page
        .evaluate((url) => {
          window.location.href = url;
        }, target)
        .catch(() => {});
      const settled = await appDocumentState();
      expect(settled, `${target} must not take over the top frame`).toEqual({
        href: "app://bundle/index.html",
        shellAlive: true,
      });
      // A committed reload clears the harness's pending-navigation state
      // from the blocked attempt before the next test runs.
      await page.goto("app://bundle/index.html");
      await expect(page.getByTestId("app-shell")).toBeVisible();
    }
  });
});
