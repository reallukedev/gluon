// Usage: node scripts/screenshots/take.mjs <setup code>
// Env: GLUON_URL (default http://localhost:8130), OUT (default docs/screenshots)
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, request } from "playwright";
import sharp from "sharp";

const BASE = process.env.GLUON_URL ?? "http://localhost:8130";
const OUT = process.env.OUT ?? path.join(import.meta.dirname, "../../docs/screenshots");
const code = process.argv[2];
if (!code) throw new Error("Pass the setup code from Gluon's log (or <GLUON_DATA>/setup-code).");

const hideDevTools = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }";

async function open(ctx, url, ready, size) {
  const page = await ctx.newPage();
  if (size) await page.setViewportSize(size);
  await page.addInitScript((css) => {
    document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: css })));
  }, hideDevTools);
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  if (ready) await page.getByText(ready, { exact: false }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500);
  return page;
}

async function shoot(page, name) {
  const raw = await page.screenshot({ animations: "disabled", caret: "hide" });
  const png = await sharp(raw).png({ palette: true, quality: 95, effort: 10, compressionLevel: 9 }).toBuffer();
  await fs.writeFile(path.join(OUT, name), png);
  console.log(`${name} ${Math.round(png.length / 1024)} KB`);
  await page.close();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US" });

const password = process.env.GLUON_PASSWORD ?? "demo-password-1";
let r = await ctx.request.post(`${BASE}/api/auth/setup`, { data: { code, username: "sam", displayName: "Sam", password } });
if (r.status() === 409) r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: "sam", password } });
if (!r.ok()) throw new Error(`Sign-in failed: ${r.status()} ${await r.text()}`);
await ctx.request.patch(`${BASE}/api/me/prefs`, { data: { onboarding: "pending" } });

await shoot(await open(ctx, "/welcome", "meet", { width: 1280, height: 800 }), "setup.png");

await ctx.request.patch(`${BASE}/api/me/prefs`, { data: { onboarding: "done" } });

// Made-up household, pins and a site, added once.
const json = async (res) => (await res).json();
const pinned = (await json(ctx.request.get(`${BASE}/api/me/pins`))).map((p) => p.target);
for (const name of ["Photos", "Documents", "Media", "Music"]) {
  const target = `/DATA/${name.toLowerCase()}`;
  if (!pinned.includes(target)) await ctx.request.post(`${BASE}/api/me/pins`, { data: { kind: "folder", target, label: name } });
}
const people = JSON.stringify(await json(ctx.request.get(`${BASE}/api/people`)));
for (const [username, displayName, role] of [["alex", "Alex", "admin"], ["jordan", "Jordan", "member"], ["riley", "Riley", "member"]]) {
  if (people.includes(`"${username}"`)) continue;
  const invite = await json(ctx.request.post(`${BASE}/api/people/invites`, { data: { role, displayName } }));
  const guest = await request.newContext();
  const joined = await guest.post(`${BASE}/api/auth${invite.path}`, { data: { username, displayName, password: `household-${password}` } });
  if (!joined.ok()) throw new Error(`${displayName} couldn't join: ${await joined.text()}`);
  await guest.dispose();
}
let site = (await json(ctx.request.get(`${BASE}/api/sites`))).sites.find((x) => x.name === "Family recipes");
site ??= await json(ctx.request.post(`${BASE}/api/sites`, { data: { name: "Family recipes", start: "starter" } }));
const siteId = site.id ?? site.site?.id;

await shoot(await open(ctx, "/", "Good"), "home.png");
await shoot(await open(ctx, "/apps", "Vaultwarden"), "apps.png");
const app = await open(ctx, "/apps/immich", "How it's put together");
const { y } = await app.getByText("How it's put together").first().boundingBox();
await app.mouse.wheel(0, y - 44);
await app.waitForTimeout(500);
await shoot(app, "app.png");
await shoot(await open(ctx, "/diagnostics", "Check something specific"), "diagnostics.png");
await shoot(await open(ctx, "/files", "IMG_"), "files.png");
await shoot(await open(ctx, "/system", "Hardware and software"), "system.png");
await shoot(await open(ctx, "/settings/people", "Riley"), "people.png");
await shoot(await open(ctx, "/settings/alerts", "Vaultwarden"), "alerts.png");
await shoot(await open(ctx, `/sites/${siteId}`, "style.css"), "sites.png");
const term = await open(ctx, "/terminal", "Run a command");
await term.getByPlaceholder("Type a command").fill("docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'");
await term.keyboard.press("Enter");
await term.getByText("vaultwarden-vaultwarden-1").first().waitFor();
await term.waitForTimeout(1000);
await shoot(term, "terminal.png");
await shoot(await open(ctx, "/settings/activity", "Riley"), "activity.png");

const dark = await browser.newContext({ storageState: await ctx.storageState(), viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", locale: "en-US" });
await shoot(await open(dark, "/", "Good"), "home-dark.png");

const phone = await browser.newContext({ storageState: await ctx.storageState(), viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US" });
await shoot(await open(phone, "/", "Good"), "phone.png");
await shoot(await open(phone, "/apps", "Vaultwarden"), "phone-apps.png");

await browser.close();
