# electron

Electron main + preload, plain TypeScript bundled by
`scripts/build-electron.mjs`. Security-sensitive files: `main/windowSecurity.ts`,
`main/ipcPolicy.ts`, `shared/appCsp.ts`, `shared/linkPolicy.ts`. IPC handlers
live in `main/ipcHandlers.ts`, the sidecar transport in `main/sidecar.ts`.

Narrow commands:

```sh
pnpm exec tsc -p electron --noEmit   # typecheck
node scripts/build-electron.mjs      # build main/preload
```

A change to any security policy (CSP, link/IPC policy, path schema) also needs
`just test-e2e-security`.
