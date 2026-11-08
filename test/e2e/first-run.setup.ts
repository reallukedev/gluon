import { existsSync } from "node:fs";
import { admin, adminState, clickToOpen, expect, open, readSetupCode, setupCodePath, signedOut, test } from "./fixtures";

test("first-run setup rejects a wrong code, then creates the admin with the right one", async ({ page, browser }) => {
  await open(page, "/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Let's set up/ })).toBeVisible();

  const code = page.getByLabel("Setup code");
  const create = page.getByRole("button", { name: "Create admin account" });

  await code.fill("AAAA-BBBB-CCCC");
  await page.getByLabel("Your name").fill(admin.name);
  await page.getByLabel("Username").fill(admin.username);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByLabel("Password again").fill(admin.password);
  await create.click();
  await expect(page.getByText("That setup code doesn't match")).toBeVisible();
  await expect(code).toHaveAttribute("aria-invalid", "true");

  const rightCode = readSetupCode();
  await code.fill(rightCode);
  await page.getByLabel("Password again").fill(`${admin.password} typo`);
  await create.click();
  await expect(page.getByText("The passwords don't match.")).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel("Password again").fill(admin.password);
  await create.click();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Hi Sam, meet / })).toBeVisible();
  expect(existsSync(setupCodePath()), "the setup code file is removed once used").toBe(false);

  await clickToOpen(page.getByRole("button", { name: "Skip setup" }), page.getByRole("heading", { level: 1, name: "Home" }));
  await expect(page).toHaveURL(/\/$/);
  await page.context().storageState({ path: adminState });

  // Setup can't be run a second time, even with the code that worked.
  const stranger = await browser.newContext({ storageState: signedOut, baseURL: test.info().project.use.baseURL });
  const again = await stranger.newPage();
  await open(again, "/setup");
  await expect(again).toHaveURL(/\/login$/);
  const replay = await stranger.request.post("/api/auth/setup", {
    data: { code: rightCode, username: "intruder", password: "intruder password" },
  });
  expect(replay.status()).toBe(409);
  await stranger.close();
});
