import type { Locator, Page } from "@playwright/test";
import { actUntil, expect, open, test } from "./fixtures";

// Tab order is a desktop concern; on phones the navigation sits in a drawer behind a button.
test.skip(({ isMobile }) => isMobile, "keyboard navigation is checked on desktop");

/** Where focus is: its index among the main navigation's links (-1 if elsewhere), and whether it shows a ring. */
function focus(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    const links = [...document.querySelectorAll('nav[aria-label="Main"] a')];
    return {
      what: `${el.tagName} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`,
      navIndex: links.indexOf(el),
      ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2,
    };
  });
}

function openWithKeyboard(page: Page, opener: Locator, opened: Locator) {
  return actUntil(opener, async () => {
    await opener.focus();
    await page.keyboard.press("Enter");
  }, opened);
}

test("the first Tab offers a skip link that moves focus to the page content", async ({ page }) => {
  await open(page, "/system");
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "System" })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  // The next Tab continues inside the page, not back in the sidebar.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
});

test("Tab reaches every main navigation link in order, each with a visible focus ring", async ({ page }) => {
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
  const count = await links.count();
  expect(count).toBeGreaterThan(3);

  const reached: number[] = [];
  for (let i = 0; i < 30 && reached.length < count; i++) {
    await page.keyboard.press("Tab");
    const f = await focus(page);
    expect(f.ring, `focus ring on ${f.what}`).toBe(true);
    if (f.navIndex >= 0) reached.push(f.navIndex);
  }
  expect(reached).toEqual([...Array(count).keys()]);

  // Back up to Diagnostics and open it from the keyboard.
  const diagnostics = links.filter({ has: page.getByText("Diagnostics", { exact: true }) });
  const target = await diagnostics.evaluate((el) => [...el.parentElement!.closest("nav")!.querySelectorAll("a")].indexOf(el as HTMLAnchorElement));
  for (let i = count - 1; i > target; i--) await page.keyboard.press("Shift+Tab");
  await expect(diagnostics).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/diagnostics$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Diagnostics" })).toBeVisible();
});

test("the account menu and search give focus back to their button when closed with Escape", async ({ page }) => {
  await open(page, "/sites");
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();

  const account = page.getByRole("button", { name: /^Account/ });
  await openWithKeyboard(page, account, page.getByRole("menu", { name: /^Account/ }));
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(account).toBeFocused();

  const search = page.getByRole("complementary").getByRole("button", { name: "Search" });
  const palette = page.getByRole("dialog", { name: "Search" });
  await openWithKeyboard(page, search, palette);
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();
});

test("closing the invite dialog with Escape or Cancel gives focus back to its button", async ({ page }) => {
  await open(page, "/settings/people");
  const invite = page.getByRole("button", { name: "Invite someone" });
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await openWithKeyboard(page, invite, dialog);
  await expect(dialog.getByLabel("Their name")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(invite).toBeFocused({ timeout: 3_000 });

  await openWithKeyboard(page, invite, dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(invite).toBeFocused({ timeout: 3_000 });
});
