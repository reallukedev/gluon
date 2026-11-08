import { clickToOpen, expect, newContext, open, openAccountMenu, openMainNav, signedOut, test, uniqueName } from "./fixtures";

test("an admin invites a household member, who can't reach admin pages", async ({ page, browser }, testInfo) => {
  const name = `Robin ${testInfo.project.name}`;
  const username = uniqueName(testInfo, "robin");
  const password = "robin's long password";

  await open(page, "/settings/people");
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await clickToOpen(page.getByRole("button", { name: "Invite someone" }), dialog);
  await dialog.getByLabel("Their name").fill(name);
  await expect(dialog.getByRole("radio", { name: /^In the household/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Make invite link" }).click();

  const ready = page.getByRole("dialog", { name: `Invite for ${name}` });
  const link = ready.getByRole("textbox", { name: "Invite link" });
  await expect(link).toHaveValue(/\/invite\/[\w-]{16,}$/);
  const invitePath = new URL(await link.inputValue()).pathname;
  await ready.getByRole("button", { name: "Done" }).click();
  await expect(ready).toBeHidden();

  // The new person, on their own device.
  const memberCtx = await newContext(browser, testInfo, signedOut);
  const member = await memberCtx.newPage();
  await open(member, invitePath);
  await expect(member.getByRole("heading", { name: `Welcome, ${name}` })).toBeVisible();
  await expect(member.getByLabel("Your name")).toHaveValue(name);
  await member.getByLabel("Username").fill(username);
  await member.getByLabel("Password", { exact: true }).fill(password);
  await member.getByLabel("Password again").fill(password);
  await member.getByRole("button", { name: "Create my account" }).click();

  await expect(member).toHaveURL(/\/welcome$/);
  // The welcome screen greets them by first name.
  await expect(member.getByRole("heading", { level: 1, name: "Welcome, Robin", exact: true })).toBeVisible();
  await clickToOpen(member.getByRole("button", { name: "Skip to Home" }), member.getByRole("heading", { level: 1, name: "Home" }));

  const nav = await openMainNav(member);
  await expect(nav.getByRole("link")).toHaveCount(1);
  await expect(nav.getByRole("link")).toHaveAccessibleName(/^Home( \d+ needs? you)?$/);
  const menu = await openAccountMenu(member);
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await member.keyboard.press("Escape");

  for (const path of ["/apps", "/system", "/terminal", "/diagnostics", "/network", "/storage"]) {
    await open(member, path);
    await expect(member, `${path} sends a member home`).toHaveURL(/\/$/);
    await expect(member.getByRole("main").getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  }
  for (const path of ["/settings/people", "/settings/server", "/settings/updates"]) {
    const res = await open(member, path);
    expect(res?.status(), `${path} is not there for a member`).toBe(404);
  }
  const people = await member.request.get("/api/people");
  expect(people.status()).toBe(403);
  const invite = await member.request.post("/api/people/invites", { data: { role: "admin", displayName: "Sneaky" } });
  expect(invite.status()).toBe(403);

  // The link worked once and is spent now.
  const strangerCtx = await newContext(browser, testInfo, signedOut);
  const stranger = await strangerCtx.newPage();
  await open(stranger, invitePath);
  await expect(stranger.getByRole("heading", { level: 1, name: "This invite has been used" })).toBeVisible();
  await expect(stranger.getByRole("button", { name: "Create my account" })).toHaveCount(0);

  // And the admin sees them, in the household.
  await page.reload();
  const row = page.getByRole("table", { name: "People" }).getByRole("row").filter({ hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Household");
  await expect(row).toContainText(name);

  await memberCtx.close();
  await strangerCtx.close();
});

test("Invite someone opens on the first click, right as the page appears", async ({ page }) => {
  // No retry here: a click made between the page showing and its section hydrating used to be dropped.
  for (let i = 0; i < 3; i++) {
    await open(page, "/settings/people");
    await page.getByRole("button", { name: "Invite someone" }).click();
    const dialog = page.getByRole("dialog", { name: "Invite someone" });
    await expect(dialog).toBeVisible({ timeout: 2_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});
