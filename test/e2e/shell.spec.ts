import { accessSync, constants } from "node:fs";
import type { Page } from "@playwright/test";
import { actUntil, clickToOpen, expect, isPhone, open, openMainNav, test } from "./fixtures";

// Without root, Gluon can't read the host's fstab and the Storage page fails as a whole.
const fstabReadable = (() => {
  try {
    accessSync("/proc/1/root/etc/fstab", constants.R_OK);
    return true;
  } catch {
    return false;
  }
})();

const pages: { path: string; heading: string }[] = [
  { path: "/", heading: "Home" },
  { path: "/apps", heading: "Apps" },
  { path: "/apps/store", heading: "Apps" },
  { path: "/apps/images", heading: "Apps" },
  { path: "/apps/volumes", heading: "Apps" },
  { path: "/apps/networks", heading: "Apps" },
  { path: "/apps/disk", heading: "Apps" },
  { path: "/apps/custom", heading: "Apps" },
  { path: "/apps/new", heading: "Make an app" },
  { path: "/files", heading: "Files" },
  { path: "/storage", heading: "Storage" },
  { path: "/network", heading: "Network" },
  { path: "/network/router", heading: "Router" },
  { path: "/sites", heading: "Sites" },
  { path: "/system", heading: "System" },
  { path: "/diagnostics", heading: "Diagnostics" },
  { path: "/terminal", heading: "Terminal" },
  { path: "/settings/appearance", heading: "Appearance" },
  { path: "/settings/home", heading: "Home page" },
  { path: "/settings/navigation", heading: "Sidebar & shortcuts" },
  { path: "/settings/formats", heading: "Clock, dates & units" },
  { path: "/settings/notifications", heading: "Notifications" },
  { path: "/settings/security", heading: "Security" },
  { path: "/settings/alerts", heading: "Alerts" },
  { path: "/settings/activity", heading: "Activity" },
  { path: "/settings/people", heading: "People" },
  { path: "/settings/server", heading: "Server" },
  { path: "/settings/integrations", heading: "Integrations" },
  { path: "/settings/updates", heading: "Updates" },
  { path: "/settings/about", heading: "About Gluon" },
];

test.describe("every page", () => {
  for (const { path, heading } of pages) {
    test(`${path} loads with its heading, no errors and no sideways scroll`, async ({ page, guard }) => {
      const res = await open(page, path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`:\\d+${path}$`));

      const main = page.getByRole("main");
      if (path === "/storage" && !fstabReadable) {
        test.info().annotations.push({ type: "issue", description: "Storage fails as a whole when /etc/fstab is unreadable" });
        await expect(main.getByRole("heading", { level: 1, name: "This page didn't load" })).toBeVisible();
        await expect(main.getByText("Nothing on the server was changed.")).toBeVisible();
        await expect(main.getByRole("button", { name: "Try again" })).toBeVisible();
        return;
      }
      await expect(main.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
      if (path.startsWith("/settings/")) await expect(page.getByRole("heading", { level: 1 }), "one page title").toHaveCount(1);
      // Let the page's own data requests finish so their failures show up as console errors.
      await page.waitForLoadState("networkidle");

      const overflow = () => page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
      expect(await overflow(), "page is wider than the screen").toBeLessThanOrEqual(0);
      expect(guard.consoleErrors).toEqual([]);
    });
  }
});

const navLinks = [
  ["Home", "/"],
  ["Apps", "/apps"],
  ["Files", "/files"],
  ["Storage", "/storage"],
  ["Network", "/network"],
  ["Sites", "/sites"],
  ["System", "/system"],
  ["Diagnostics", "/diagnostics"],
  ["Terminal", "/terminal"],
] as const;

// A link can carry a live count: "Home 1 needs you", "Home 2 need you".
const linkName = (name: string) => new RegExp(`^${name}( \\d+ needs? you)?$`);

test("the main navigation reaches every section and marks the current one", async ({ page }) => {
  await open(page, "/diagnostics");
  const links = (await openMainNav(page)).getByRole("link");
  await expect(links).toHaveCount(navLinks.length);
  for (const [i, [name]] of navLinks.entries()) await expect(links.nth(i)).toHaveAccessibleName(linkName(name));

  for (const [name, path] of navLinks) {
    const nav = await openMainNav(page);
    await nav.getByRole("link", { name: linkName(name) }).click();
    await expect(page).toHaveURL(new RegExp(`:\\d+${path}$`));
    if (name !== "Storage") await expect(page.getByRole("main").getByRole("heading", { level: 1, name })).toBeVisible();
    // On phones the drawer gets out of the way once a section is picked.
    if (isPhone(page)) await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
    const current = (await openMainNav(page)).locator('a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName(linkName(name));
  }
});

test.describe("search", () => {
  async function openSearch(page: Page) {
    const palette = page.getByRole("dialog", { name: "Search" });
    if (isPhone(page)) {
      await clickToOpen(page.getByRole("banner").getByRole("button", { name: "Search" }), palette);
    } else {
      const button = page.getByRole("complementary").getByRole("button", { name: "Search" });
      await actUntil(button, () => page.keyboard.press("ControlOrMeta+k"), palette);
    }
    return palette;
  }

  test("finds a page by name and opens it with the keyboard", async ({ page }) => {
    await open(page, "/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    const palette = await openSearch(page);
    const box = palette.getByRole("combobox", { name: "Search apps, files, settings and more" });
    await expect(box).toBeFocused();

    await box.fill("people");
    const best = palette.getByRole("group", { name: "Best match" }).getByRole("option");
    await expect(best).toHaveCount(1);
    await expect(best).toContainText("People");
    await expect(best).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/people$/);
    await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "People" })).toBeVisible();
    await expect(palette).toBeHidden();
  });

  test("arrow keys move the selection and Escape closes without going anywhere", async ({ page }) => {
    await open(page, "/sites");
    await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
    const palette = await openSearch(page);
    const options = palette.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).not.toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/\/sites$/);
  });

  test("a search with no match says so", async ({ page }) => {
    await open(page, "/");
    const palette = await openSearch(page);
    await palette.getByRole("combobox").fill("zzqx nothing matches this");
    await expect(palette.getByRole("option")).toHaveCount(0);
    await expect(palette.getByRole("status")).not.toBeEmpty();
  });
});
