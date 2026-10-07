import "server-only";
import { all, now, one } from "./db";
import { getSetting } from "./settings";
import { getPrefs, updatePrefs } from "./prefs";
import { findById, type User } from "./auth/users";
import { listApps } from "./docker/apps";
import { activePlatform, PLATFORM_NAME } from "./platform";
import { getInventory } from "./storage/inventory";
import { tryReadConfig, routeUrl, isRedirect, THIS_SERVER, type Backend, type RoutesConfig } from "./caddy/routes";
import { counts, listOpen } from "./findings";
import { listSubscriptions } from "./notify/subscriptions";
import { NAV } from "@/lib/nav";
import {
  resumeAt,
  type AdminPlan,
  type AdminStep,
  type InventoryAddresses,
  type InventoryApps,
  type InventoryAttention,
  type InventoryDrives,
  type MemberPlan,
  type MemberStep,
  type OnboardingSummary,
  type Plan,
} from "@/lib/onboarding";
import type { Zone } from "./net-zone";
import { mfaRequired } from "./auth/policy";

/**
 * First run. Which steps apply is decided here, from real state, each time /welcome loads:
 *  - updates: only for admins, and only while nobody has chosen how Gluon updates (it's server-wide).
 *  - people:  only for the admin who set the server up; admins who were invited join a household
 *             that already exists.
 *  - security: only when Gluon is published to the internet or this admin is signed in from away,
 *             and they don't have two-step yet.
 * Alerts are per person, so every admin gets that step.
 */

const GLUON_PORT = Number(process.env.PORT ?? "8130");

/**
 * Gluon's own public address: the public name in Settings → Server, else a route pointing at it.
 * Pass the routes when they've just been read, so they aren't read again.
 */
export function gluonPublicAddress(routes?: RoutesConfig | null): string | null {
  const host = getSetting("publicHost").trim();
  if (host) return host;
  const cfg = routes === undefined ? tryReadConfig() : routes;
  if (!cfg) return null;
  const local = new Set([THIS_SERVER, "localhost", "127.0.0.1", "::1"]);
  const isGluon = (b: Backend) => local.has(b.host) && b.port === GLUON_PORT;
  const r = cfg.routes.find((x) => x.enabled && !isRedirect(x) && isGluon(x.backend));
  if (r) return routeUrl(cfg, r).replace(/^https?:\/\//, "");
  return isGluon(cfg.fallback.backend) ? cfg.base_domain : null;
}

const updatesTouched = () => !!one<{ key: string }>("SELECT key FROM settings WHERE key = 'updates'");
const wasInvited = (userId: string) => !!one<{ n: number }>("SELECT 1 AS n FROM invites WHERE used_by = ?", userId);

export function planFor(user: User, zone: Zone): Plan {
  const saved = getPrefs(user.id).onboarding;
  const serverName = getSetting("serverName");
  const row = findById(user.id);
  const mfa = !!row?.totp_enabled;

  if (user.role === "admin") {
    const publicAt = gluonPublicAddress();
    const steps: AdminStep[] = ["found"];
    if (!updatesTouched()) steps.push("updates");
    steps.push("notify");
    if (!wasInvited(user.id)) steps.push("people");
    if ((publicAt || zone === "away") && !mfa) steps.push("security");
    steps.push("summary");
    const plan: AdminPlan = {
      role: "admin",
      steps,
      start: resumeAt(saved, steps) as AdminStep,
      serverName,
      reach: { zone, publicAt },
      requireMfaAway: mfaRequired("admin", "away"),
      mfa,
    };
    return plan;
  }

  const inviter = one<{ display_name: string }>(
    "SELECT u.display_name FROM invites i JOIN users u ON u.id = i.created_by WHERE i.used_by = ? ORDER BY i.used_at DESC LIMIT 1",
    user.id,
  );
  const firstAdmin = one<{ display_name: string }>("SELECT display_name FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at LIMIT 1");
  const steps: MemberStep[] = ["hello", "apps", "ready"];
  const plan: MemberPlan = {
    role: "member",
    steps,
    start: resumeAt(saved, steps) as MemberStep,
    serverName,
    admin: inviter?.display_name ?? firstAdmin?.display_name ?? null,
    invitedBy: inviter?.display_name ?? null,
    canSeeStatus: getSetting("householdCanSeeStatus"),
  };
  return plan;
}

/**
 * Accounts made while Gluon started people with only Home in the sidebar (and a picker on Home to add
 * the rest) still have that sidebar. The picker is gone, so give them the whole sidebar back, once.
 */
export function releaseLegacySidebar(userId: string) {
  const p = getPrefs(userId);
  if (p.onboarding !== "pending" || !p.sidebarHidden.length) return;
  const legacy = NAV.filter((n) => n.id !== "home").map((n) => n.id);
  const hidden = new Set(p.sidebarHidden);
  if (hidden.size === legacy.length && legacy.every((id) => hidden.has(id))) updatePrefs(userId, { sidebarHidden: [] });
}

// ---------------------------------------------------------------- first look

export async function inventoryApps(): Promise<InventoryApps> {
  const [apps, platform] = await Promise.all([listApps(), activePlatform().catch(() => "none" as const)]);
  const list = apps.filter((a) => !a.self && !a.copyOf);
  const sources = { umbrel: 0, casaos: 0, compose: 0, docker: 0 };
  for (const a of list) sources[a.source === "gluon" ? "compose" : a.source]++;
  const ranked = [...list].sort((a, b) => Number(b.line === "running") - Number(a.line === "running") || Number(!!b.icon) - Number(!!a.icon) || a.name.localeCompare(b.name));
  return {
    total: list.length,
    running: list.filter((a) => a.line === "running").length,
    sources,
    platform: PLATFORM_NAME[platform],
    sample: ranked.slice(0, 12).map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
  };
}

export async function inventoryDrives(): Promise<InventoryDrives> {
  const inv = await getInventory(false);
  const disks = [...inv.disks].sort((a, b) => Number(b.system) - Number(a.system) || b.size - a.size);
  return { disks: disks.map((d) => ({ id: d.id, title: d.title, summary: d.summary, system: d.system })), warnings: inv.warnings };
}

export function inventoryAddresses(): InventoryAddresses {
  const cfg = tryReadConfig();
  if (!cfg) return { configured: false, count: 0, sample: [], gluon: gluonPublicAddress(null) };
  const live = cfg.routes.filter((r) => r.enabled);
  return {
    configured: true,
    count: live.length,
    sample: live.slice(0, 4).map((r) => ({ name: r.name, url: routeUrl(cfg, r).replace(/^https:\/\//, "") })),
    gluon: gluonPublicAddress(cfg),
  };
}

export function inventoryAttention(): InventoryAttention {
  const c = counts();
  return { fault: c.fault, attention: c.attention, top: listOpen().slice(0, 3).map((f) => ({ id: f.id, title: f.title, severity: f.severity })) };
}

// ---------------------------------------------------------------- the last admin screen

interface InviteRow {
  display_name: string | null;
  role: "admin" | "member";
  expires_at: number;
  used_at: number | null;
  joined_name: string | null;
}

export async function summaryFor(user: User): Promise<OnboardingSummary> {
  const admin = user.role === "admin";
  const subs = await listSubscriptions(user);
  const u = getSetting("updates");
  const rows = admin
    ? all<InviteRow>(
        `SELECT i.display_name, i.role, i.expires_at, i.used_at, u.display_name AS joined_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
         WHERE i.created_by = ? AND (i.used_by IS NOT NULL OR (i.used_at IS NULL AND i.expires_at > ?))
         ORDER BY i.created_at`,
        user.id,
        now(),
      )
    : [];
  return {
    updates: admin ? { touched: updatesTouched(), channel: u.channel, auto: u.auto, hour: u.hour, nightlyTiming: u.nightlyTiming } : null,
    alerts: subs.subscriptions.map((s) => ({ name: s.channelName, kind: s.channelKind })),
    invites: admin
      ? {
          waiting: rows.filter((r) => !r.joined_name && !r.used_at).map((r) => ({ name: r.display_name, role: r.role, expiresAt: r.expires_at })),
          joined: rows.filter((r) => r.joined_name).map((r) => ({ name: r.joined_name!, role: r.role })),
        }
      : null,
    mfa: !!findById(user.id)?.totp_enabled,
  };
}
