# End-to-end tests

Playwright drives a real Gluon in Chromium, at desktop and phone sizes.

```sh
npx playwright install chromium   # once
npm run test:e2e
```

The run builds Gluon, starts it on port 8131 (`E2E_PORT`) with an empty data folder (`GLUON_E2E_DATA`,
a temp folder by default) and walks first-run setup, so every run starts from a new server. It needs
no Docker or root: pages that depend on the host are allowed to report that they can't reach it.

- `E2E_SKIP_BUILD=1` reuses the last `next build`; `E2E_DEV=1` runs `next dev` instead.
- `E2E_CHROMIUM_PATH` points at a Chromium of your own instead of Playwright's.
- `npx playwright show-report` opens the last report.
