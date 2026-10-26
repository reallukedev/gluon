import "server-only";
import { ADMIN_DEFAULT, ALL_APPS, HOUSEHOLD_DEFAULT, appItem, layoutSchema, withStart, type HomeLayout, type WidgetItem } from "@/lib/home";
import { now, one, run } from "./db";
import { badRequest } from "./errors";
import { getPrefs } from "./prefs";
import { appsForMember, listApps, type AppSummary } from "./docker/apps";
import type { Role } from "./auth/users";

const MAX_BYTES = 96 * 1024;

function read(owner: string): HomeLayout | null {
  const row = one<{ json: string }>("SELECT json FROM home_layouts WHERE owner = ?", owner);
  if (!row) return null;
  const parsed = layoutSchema.safeParse(JSON.parse(row.json));
  // Layouts saved before the greeting and search bar were pinnable get them once, at the top (saved on next change).
  return parsed.success ? withStart(parsed.data) : null;
}

function write(owner: string, layout: unknown): HomeLayout {
  const parsed = layoutSchema.safeParse(layout);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message?.startsWith("That's") ? parsed.error.issues[0].message : "That layout isn't valid.");
  const json = JSON.stringify(parsed.data);
  if (json.length > MAX_BYTES) throw badRequest("Your home page is too big to save. Unpin a few things or shorten notes.");
  run(
    "INSERT INTO home_layouts (owner, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    owner,
    json,
    now(),
  );
  return parsed.data;
}

export function householdDefault(): HomeLayout {
  return read("__default__") ?? HOUSEHOLD_DEFAULT;
}

/** Apps this person can open in a browser, in the order Apps lists them. */
async function openableApps(userId: string, role: Role): Promise<AppSummary[]> {
  const apps = role === "admin" ? (await listApps()).filter((a) => !a.hidden) : await appsForMember(userId);
  return apps.filter((a) => a.urls.home || a.urls.away);
}

/**
 * Pinned apps are one `app` card each. Two older shapes become cards here:
 * - the single Apps block (`apps`) of personal layouts from before, showing the person's pinned apps (prefs.homeApps),
 *   the apps it was set to, or all of them: replaced once, in place, and saved with the next change;
 * - the "all your apps" placeholder in default layouts, expanded for whoever is reading it.
 * Defaults also drop cards for apps this person can't open (an admin's layout made the household default).
 */
async function withAppCards(layout: HomeLayout, userId: string, role: Role, personal: boolean): Promise<HomeLayout> {
  const blocks = layout.items.filter((i) => i.type === ALL_APPS);
  const needsApps = blocks.length > 0 || (!personal && layout.items.some((i) => i.type === "app"));
  if (!needsApps) return personal && !layout.migrated?.includes("app-cards") ? { ...layout, migrated: [...(layout.migrated ?? []), "app-cards"] } : layout;
  const apps = await openableApps(userId, role).catch(() => [] as AppSummary[]);
  const byId = new Map(apps.map((a) => [a.id, a]));
  const onPage = new Set(layout.items.filter((i) => i.type === "app").map((i) => String(i.config.appId)));
  const cardsFor = (block: WidgetItem): WidgetItem[] => {
    const cfg = block.config as { show?: string; ids?: unknown };
    const pinned = personal ? getPrefs(userId).homeApps : null;
    const ids =
      pinned ??
      (cfg.show === "selected" && Array.isArray(cfg.ids) && cfg.ids.length ? cfg.ids.map(String) : apps.map((a) => a.id));
    return ids
      .map((id) => byId.get(id))
      .filter((a): a is AppSummary => !!a && !onPage.has(a.id))
      .map((a) => {
        onPage.add(a.id);
        return appItem(a, "i");
      });
  };
  const items: WidgetItem[] = [];
  let expanded = false;
  for (const it of layout.items) {
    if (it.type === ALL_APPS) {
      if (!expanded) items.push(...cardsFor(it));
      expanded = true;
      continue;
    }
    if (!personal && it.type === "app" && !byId.has(String(it.config.appId))) continue;
    items.push(it);
  }
  return { ...layout, items: items.slice(0, 80), migrated: personal ? [...new Set([...(layout.migrated ?? []), "app-cards"])] : layout.migrated };
}

export async function homeFor(userId: string, role: Role): Promise<{ layout: HomeLayout; personal: boolean }> {
  const mine = read(userId);
  if (mine) return { layout: await withAppCards(mine, userId, role, true), personal: true };
  const base = role === "admin" ? ADMIN_DEFAULT : householdDefault();
  return { layout: await withAppCards(base, userId, role, false), personal: false };
}

export const saveHome = (userId: string, layout: unknown) => write(userId, layout);
export const resetHome = (userId: string) => run("DELETE FROM home_layouts WHERE owner = ?", userId);
export const saveHouseholdDefault = (layout: unknown) => write("__default__", layout);
