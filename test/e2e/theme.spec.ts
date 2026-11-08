import type { Page } from "@playwright/test";
import { expect, newContext, newPerson, open, openAccountMenu, signIn, test, uniqueName } from "./fixtures";

// Ground and ink from DESIGN.md: bone and graphite by day, graphite and parchment by night.
const light = { ground: "rgb(244, 243, 239)", ink: "rgb(24, 24, 26)" };
const dark = { ground: "rgb(17, 18, 20)", ink: "rgb(236, 231, 219)" };

function colors(page: Page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const h1 = document.querySelector("main h1");
    return { ground: body.backgroundColor, ink: h1 ? getComputedStyle(h1).color : null };
  });
}

for (const path of ["/", "/settings/appearance", "/login"]) {
  test(`${path} follows the device's light and dark setting`, async ({ page, browser }, testInfo) => {
    let target = page;
    if (path === "/login") {
      const ctx = await newContext(browser, testInfo, { cookies: [], origins: [] });
      target = await ctx.newPage();
    }
    await target.emulateMedia({ colorScheme: "light" });
    await open(target, path);
    await expect(target.getByRole("heading").first()).toBeVisible();
    await expect.poll(() => colors(target).then((c) => c.ground)).toBe(light.ground);
    if (path !== "/login") expect((await colors(target)).ink).toBe(light.ink);

    await target.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => colors(target).then((c) => c.ground)).toBe(dark.ground);
    if (path !== "/login") expect((await colors(target)).ink).toBe(dark.ink);
    if (target !== page) await target.context().close();
  });
}

test("a theme picked in the account menu beats the device setting and follows the person", async ({ browser }, testInfo) => {
  // Its own person: the choice is saved to the account, and the admin's is shared with other tests.
  const person = { name: "Dana", username: uniqueName(testInfo, "dana"), password: "dana's long password" };
  const ctx = await newPerson(browser, testInfo, person);
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect.poll(() => colors(page).then((c) => c.ground)).toBe(light.ground);

  let menu = await openAccountMenu(page);
  await menu.getByRole("menuitem", { name: "Use dark theme" }).click();
  await expect.poll(() => colors(page).then((c) => c.ground)).toBe(dark.ground);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect((await colors(page)).ground).toBe(dark.ground);

  // A different device, with nothing stored in the browser, signs in to the same choice.
  const other = await newContext(browser, testInfo, { cookies: [], origins: [] });
  const otherPage = await other.newPage();
  await otherPage.emulateMedia({ colorScheme: "light" });
  await open(otherPage, "/login");
  await signIn(otherPage, person.username, person.password);
  await expect(otherPage.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect.poll(() => colors(otherPage).then((c) => c.ground)).toBe(dark.ground);

  menu = await openAccountMenu(otherPage);
  await menu.getByRole("menuitem", { name: "Match my device's theme" }).click();
  await expect.poll(() => colors(otherPage).then((c) => c.ground)).toBe(light.ground);
  await otherPage.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => colors(otherPage).then((c) => c.ground)).toBe(dark.ground);

  await ctx.close();
  await other.close();
});
