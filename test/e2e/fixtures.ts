import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";

export const admin = { name: "Sam Admin", username: "admin", password: "e2e correct horse battery" };
export const adminState = join(import.meta.dirname, ".auth", "admin.json");
export const signedOut = { cookies: [], origins: [] };

export function setupCodePath() {
  return join(process.env.GLUON_E2E_DATA!, "setup-code");
}

export function readSetupCode() {
  return readFileSync(setupCodePath(), "utf8").trim();
}

// Requests that fail only because the test machine lacks host access (no Docker, systemd, Caddy,
// root, or outbound internet for icons). Anything else failing is a real error.
const hostOnly = [
  /\/api\/docker\//,
  /\/api\/network\/(status|exposure|routes)\b/,
  /\/api\/system\/(services|logins)\b/,
  /\/api\/onboarding\/inventory\?part=drives\b/,
  /\/api\/storage\//,
  /\/api\/icon\?/,
];

export function isHostOnlyFailure(url: string) {
  return hostOnly.some((re) => re.test(url));
}

type Guard = { consoleErrors: string[]; pageErrors: string[] };

export const test = base.extend<{ guard: Guard }>({
  // Every test fails on an uncaught page error; console errors are collected for tests that check them.
  guard: [
    async ({ page }, use) => {
      const guard: Guard = { consoleErrors: [], pageErrors: [] };
      page.on("pageerror", (err) => guard.pageErrors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const where = msg.location().url;
        if (msg.text().startsWith("Failed to load resource") && isHostOnlyFailure(where)) return;
        // Chromium aborts requests when the host's network interfaces change (Docker adding a
        // container's veth, for one). That is the machine, not Gluon.
        if (msg.text().includes("net::ERR_NETWORK_CHANGED")) return;
        guard.consoleErrors.push(`${msg.text()} (${where})`);
      });
      await use(guard);
      expect(guard.pageErrors, "uncaught errors on the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export function isPhone(page: Page) {
  return (page.viewportSize()?.width ?? 1280) < 900;
}

/**
 * Waits for the root layout to hydrate; before that a click does nothing, or falls through to the
 * browser's default (the sign-in form reloads). The root sets data-hydrated.
 */
export async function hydrated(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
}

/** page.goto, then wait until the page can be used. */
export async function open(page: Page, path: string) {
  const res = await page.goto(path);
  await hydrated(page);
  return res;
}

/**
 * Acts until `shows` is visible. Parts of a page hydrate after the root, and a click on one of
 * them in that gap is dropped, so the action is retried; but never once `shows` is up, and never
 * after the target is gone (the first action worked and only its result is slow).
 */
export async function actUntil(target: Locator, act: () => Promise<unknown>, shows: Locator) {
  await hydrated(target.page());
  await expect(async () => {
    if (await shows.isVisible()) return;
    if (await target.isVisible()) await act();
    await expect(shows).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

export function clickToOpen(target: Locator, shows: Locator) {
  return actUntil(target, () => target.click({ timeout: 2_000 }), shows);
}

/** The main navigation: the sidebar on wide screens, the drawer behind "Open navigation" on phones. */
export async function openMainNav(page: Page): Promise<Locator> {
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isPhone(page) && !(await nav.isVisible())) await clickToOpen(page.getByRole("button", { name: "Open navigation" }), nav);
  await expect(nav).toBeVisible();
  return nav;
}

export async function openAccountMenu(page: Page) {
  if (isPhone(page)) await openMainNav(page);
  const menu = page.getByRole("menu", { name: /^Account/ });
  await clickToOpen(page.getByRole("button", { name: /^Account/ }), menu);
  return menu;
}

export async function signIn(page: Page, username: string, password: string) {
  await hydrated(page);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** A username no other test, project, repeat or retry uses. Usernames allow letters, numbers, dots and dashes. */
export function uniqueName(testInfo: TestInfo, base: string) {
  return `${base}-${runHash(testInfo).toString(36)}`;
}

/**
 * Sign-in is rate limited per client address, and every test connects from 127.0.0.1. Gluon trusts
 * X-Forwarded-For from loopback (it runs behind Caddy on the same host), so tests that sign in
 * present their own home-network address, like separate devices in the house.
 */
export function ownAddress(testInfo: TestInfo) {
  const h = runHash(testInfo);
  return { "x-forwarded-for": `192.168.${(h >>> 8) % 250}.${(h % 250) + 2}` };
}

/** A number for this test, project, repeat and retry. */
function runHash(testInfo: TestInfo) {
  let h = 0;
  for (const ch of `${testInfo.testId}:${testInfo.retry}:${testInfo.repeatEachIndex}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** A browser context with the project's device settings and the given sign-in. */
export async function newContext(browser: Browser, testInfo: TestInfo, storageState: string | typeof signedOut) {
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
  return browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    storageState,
    extraHTTPHeaders: ownAddress(testInfo),
  });
}

/**
 * Creates an account through the API (invite as admin, accept as the new person) and returns a
 * context signed in as them, past the welcome screen. For tests whose subject is something else.
 */
export async function newPerson(
  browser: Browser,
  testInfo: TestInfo,
  person: { name: string; username: string; password: string; role?: "member" | "admin" },
): Promise<BrowserContext> {
  const adminCtx = await newContext(browser, testInfo, adminState);
  const invite = await adminCtx.request.post("/api/people/invites", {
    data: { role: person.role ?? "member", displayName: person.name },
  });
  expect(invite.ok(), await invite.text()).toBe(true);
  const { path } = (await invite.json()) as { path: string };
  await adminCtx.close();

  const ctx = await newContext(browser, testInfo, signedOut);
  const token = path.split("/").pop();
  const accept = await ctx.request.post(`/api/auth/invite/${token}`, {
    data: { displayName: person.name, username: person.username, password: person.password },
  });
  expect(accept.ok(), await accept.text()).toBe(true);
  const done = await ctx.request.patch("/api/me/prefs", { data: { onboarding: "done" } });
  expect(done.ok(), await done.text()).toBe(true);
  return ctx;
}
