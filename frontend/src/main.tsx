import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

// E2E-only: @wdio/tauri-service frontend bridge (console forwarding, invoke
// interception). `VITE_WDIO=1` is set by `just build-debug`; Vite replaces the
// check at build time so the plugin is tree-shaken from every other build.
if (import.meta.env.VITE_WDIO === "1") {
  import("@wdio/tauri-plugin").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
