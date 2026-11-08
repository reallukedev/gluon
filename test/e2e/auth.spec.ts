import type { Browser, Page, TestInfo } from "@playwright/test";
import { expect, newContext, newPerson, open, openAccountMenu, ownAddress, signedOut, signIn, test, uniqueName } from "./fixtures";

test.use({ storageState: signedOut, extraHTTPHeaders: async ({}, use, testInfo) => use(ownAddress(testInfo)) });

// Each test signs in to an account of its own: Gluon turns away a sign-in while another one
// to the same account is still being checked, and tests run in parallel.
async function account(browser: Browser, testInfo: TestInfo, role: "member" | "admin" = "member") {
  const person = { name: "Alex Rivera", username: uniqueName(testInfo, "alex"), password: "alex's long password", role };
  await (await newPerson(browser, testInfo, person)).close();
  return person;
}

function signInResponse(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
}

test("a wrong password is refused with a message, and the right one signs in", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  await signIn(page, me.username, "not the password");
  await expect(page.getByText("Wrong username or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /, Alex\.$/ })).toBeVisible();
});

test("an inner page asks a signed-out visitor to sign in", async ({ page }) => {
  const res = await open(page, "/settings/people");
  expect(res?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: /^Sign in to / })).toBeVisible();

  const api = await page.request.get("/api/people");
  expect(api.status()).toBe(401);
});

test("signing in after following a deep link returns to that page", async ({ page, browser }, testInfo) => {
  test.fail(true, "The redirect to /login drops the page that was asked for, so sign-in lands on Home");
  const me = await account(browser, testInfo, "admin");
  await open(page, "/settings/people");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible({ timeout: 5_000 });
});

test("sign-in follows a same-site return path and ignores off-site ones", async ({ browser }, testInfo) => {
  const me = await account(browser, testInfo, "admin");
  for (const [next, landing] of [
    ["/settings/people", /:\d+\/settings\/people$/],
    ["https://example.com/", /^http:\/\/127\.0\.0\.1:\d+\/$/],
    ["//example.com/", /^http:\/\/127\.0\.0\.1:\d+\/$/],
  ] as const) {
    const ctx = await newContext(browser, testInfo, signedOut);
    const page = await ctx.newPage();
    await open(page, `/login?next=${encodeURIComponent(next)}`);
    await signIn(page, me.username, me.password);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 }).last()).toBeVisible();
    await expect(page, `next=${next}`).toHaveURL(landing);
    await ctx.close();
  }
});

test("signing out ends the session on the server, not just in the browser", async ({ page, context, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  await signIn(page, me.username, me.password);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const session = (await context.cookies()).find((c) => c.name === "gluon_session");
  expect(session).toBeDefined();

  const menu = await openAccountMenu(page);
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await open(page, "/system");
  await expect(page).toHaveURL(/\/login$/);

  // The old cookie, replayed by hand, no longer works.
  const replay = await page.request.get("/api/me", { headers: { cookie: `gluon_session=${session!.value}` } });
  expect(replay.status()).toBe(401);
});

test("repeated wrong passwords lock that account's sign-in for a while", async ({ page, browser }, testInfo) => {
  const me = await account(browser, testInfo);
  await open(page, "/login");
  for (let i = 0; i < 5; i++) {
    const res = signInResponse(page);
    await signIn(page, me.username, `wrong ${i}`);
    expect((await res).status()).toBe(400);
    await expect(page.getByText("Wrong username or password.")).toBeVisible();
  }
  const res = signInResponse(page);
  await signIn(page, me.username, "wrong again");
  expect((await res).status()).toBe(429);
  await expect(page.getByText(/^Too many tries\. You can try again in 0:\d\d\.$/)).toBeVisible();
  const wait = page.getByRole("button", { name: /^Try again in 0:\d\d$/ });
  await expect(wait).toBeDisabled();

  // The countdown moves.
  const first = await wait.textContent();
  await expect(wait).not.toHaveText(first!);

  // Even the right password is turned away until the lock ends.
  const right = await page.request.post("/api/auth/login", { data: { username: me.username, password: me.password } });
  expect(right.status()).toBe(429);
  expect((await right.json()).error.details.retryAfter).toBeGreaterThan(1);
});
