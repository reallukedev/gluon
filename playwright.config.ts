import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "8131";
const baseURL = `http://127.0.0.1:${port}`;

// Workers and the server both read this, so it is fixed before either starts.
process.env.GLUON_E2E_DATA ??= join(tmpdir(), `gluon-e2e-${port}`);

const adminState = join(import.meta.dirname, "test/e2e/.auth/admin.json");

// Lets a machine with a preinstalled Chromium of another revision run the suite without `playwright install`.
const executablePath = process.env.E2E_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    launchOptions: { executablePath },
  },
  projects: [
    // Walks first-run setup in the UI and signs the admin in for every other test.
    { name: "setup", testMatch: /.*\.setup\.ts/, retries: 0 },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], storageState: adminState },
      dependencies: ["setup"],
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"], storageState: adminState },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "node test/e2e/server.mjs",
    url: `${baseURL}/api/health`,
    // Setup only works once per data directory, so an already running server can't be reused.
    reuseExistingServer: false,
    // Includes `next build`.
    timeout: 600_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { E2E_PORT: port, GLUON_E2E_DATA: process.env.GLUON_E2E_DATA },
  },
});
