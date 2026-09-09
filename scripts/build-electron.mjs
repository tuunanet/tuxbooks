/**
 * Bundle the Electron main and preload processes with esbuild. Both targets
 * are CJS (Electron's sandboxed preload and the package.json "main" entry),
 * with `electron` external — it is provided by the runtime.
 *
 * Output: electron/dist/main.cjs + electron/dist/preload.cjs.
 */
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "inline",
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["electron/main/index.ts"],
  outfile: "electron/dist/main.cjs",
});

await build({
  ...common,
  entryPoints: ["electron/preload/preload.ts"],
  outfile: "electron/dist/preload.cjs",
});
