# e2e

Playwright desktop E2E against the real built Electron app. Specs in `specs/`,
launch fixtures and setup in `setup/`. Reach for a single project while
iterating; the full suite is expensive.

```sh
just build-debug            # required once after changing app code
just test-e2e-seeded        # one project (also: -empty, -security, -regressions, -gpu, -hidpi)
just test-e2e               # all projects
```

The `just` recipes wrap the Linux headless Xvfb environment, so run them instead
of calling Playwright directly. Failure artifacts land in `artifacts/`.
See `docs/TESTING.md` for fixture seeding and project details.
