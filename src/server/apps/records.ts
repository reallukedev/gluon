import "server-only";
import { all, one, run, tx } from "../db";
import { appItemId } from "@/lib/home";

/**
 * After a move, everything Gluon keeps about an app under its id goes with it to the new id:
 * its settings, who in the household can open it, Home pins and cards, monitors and their open
 * findings, open reports, live announcements, integrations, and the `app` of its public addresses.
 *
 * `planRecordMove` is pure: it reads a snapshot and returns the statements to run. `carryRecords`
 * runs the SQLite part in one transaction, so a failure halfway leaves every record where it was.
 * Public addresses live in routes.json and are saved afterwards through the routes service.
 */

export interface PrefRow {
  app_id: string;
  display_name: string | null;
  description: string | null;
  icon: string | null;
  url_home: string | null;
  url_away: string | null;
  household: number;
  has_login: string | null;
  hidden: number;
  updated_at: number;
}

export interface RecordSnapshot {
  prefs: { from: PrefRow | null; to: PrefRow | null };
  access: { from: string[]; to: string[] };
  /** App pins pointing at either id. */
  pins: { id: string; userId: string; target: string }[];
  /** Home layouts (per person and the household default) that mention the old id. */
  layouts: { owner: string; json: string }[];
  /** Personal preferences whose homeApps list mentions the old id. */
  userPrefs: { userId: string; json: string }[];
  monitors: { id: string; source: string; ref: string | null; config: string; createdAt: number }[];
  /** Open findings about the old id. */
  findings: { id: string; kind: string }[];
  reports: string[];
  announcements: string[];
  integrations: string[];
  routes: { ids: string[]; fallback: boolean };
}

export interface Statement {
  sql: string;
  params: unknown[];
}

export interface RecordPlan {
  statements: Statement[];
  /** Routes whose `app` changes (and whether the fallback does). */
  routes: { ids: string[]; fallback: boolean };
  /** One line per kind of record moved, for the move's log and audit. */
  summary: string[];
}

const PREF_FIELDS = ["display_name", "description", "icon", "url_home", "url_away", "has_login"] as const;

type Item = { id: string; type: string; config: Record<string, unknown> } & Record<string, unknown>;

/** Repoint a Home layout's app cards and app lists from one id to another. Null when nothing changes. */
export function moveLayout(json: string, from: string, to: string): string | null {
  let layout: { items?: Item[] } & Record<string, unknown>;
  try {
    layout = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(layout.items)) return null;
  let changed = false;
  const hasTo = layout.items.some((i) => i.config?.appId === to);
  const items: Item[] = [];
  for (const it of layout.items) {
    const cfg = it.config ?? {};
    if (cfg.appId === from) {
      changed = true;
      if (hasTo) continue; // already on the page as the new app: the old card goes
      items.push({ ...it, id: it.type === "app" && it.id === appItemId(from) ? appItemId(to) : it.id, config: { ...cfg, appId: to } });
      continue;
    }
    if (Array.isArray(cfg.ids) && cfg.ids.includes(from)) {
      changed = true;
      items.push({ ...it, config: { ...cfg, ids: [...new Set(cfg.ids.map((x) => (x === from ? to : x)))] } });
      continue;
    }
    items.push(it);
  }
  return changed ? JSON.stringify({ ...layout, items }) : null;
}

function moveHomeApps(json: string, from: string, to: string): string | null {
  let p: { homeApps?: unknown } & Record<string, unknown>;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(p.homeApps) || !p.homeApps.includes(from)) return null;
  return JSON.stringify({ ...p, homeApps: [...new Set(p.homeApps.map((x) => (x === from ? to : x)))] });
}

export function planRecordMove(snap: RecordSnapshot, from: string, to: string, opts: { movedAt: number; now: number }): RecordPlan {
  const st: Statement[] = [];
  const summary: string[] = [];
  const add = (sql: string, ...params: unknown[]) => st.push({ sql, params });

  // Settings: the new app takes what it doesn't already have. The old copy stops being the household's.
  const f = snap.prefs.from;
  if (f) {
    const t = snap.prefs.to;
    const pick = <K extends (typeof PREF_FIELDS)[number]>(k: K) => (t && t[k] !== null && !(k === "has_login" && t[k] === "unknown") ? t[k] : f[k]);
    add(
      `INSERT INTO app_prefs (app_id, display_name, description, icon, url_home, url_away, household, has_login, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, icon = excluded.icon,
         url_home = excluded.url_home, url_away = excluded.url_away, household = excluded.household, has_login = excluded.has_login,
         hidden = excluded.hidden, updated_at = excluded.updated_at`,
      to,
      pick("display_name"),
      pick("description"),
      pick("icon"),
      pick("url_home"),
      pick("url_away"),
      f.household || t?.household ? 1 : 0,
      pick("has_login") ?? "unknown",
      t ? t.hidden : f.hidden,
      opts.now,
    );
    if (f.household) add("UPDATE app_prefs SET household = 0, updated_at = ? WHERE app_id = ?", opts.now, from);
    summary.push("its settings");
  }

  // Who can open it.
  if (snap.access.from.length) {
    for (const u of snap.access.from) if (!snap.access.to.includes(u)) add("INSERT OR IGNORE INTO app_access (app_id, user_id) VALUES (?, ?)", to, u);
    add("DELETE FROM app_access WHERE app_id = ?", from);
    summary.push(`access for ${snap.access.from.length === 1 ? "1 person" : `${snap.access.from.length} people`}`);
  }

  // Home: pins, cards, and the older homeApps list.
  const pinned = new Set(snap.pins.filter((p) => p.target === to).map((p) => p.userId));
  let homes = 0;
  for (const p of snap.pins) {
    if (p.target !== from) continue;
    homes++;
    if (pinned.has(p.userId)) add("DELETE FROM pins WHERE id = ?", p.id);
    else {
      add("UPDATE pins SET target = ? WHERE id = ?", to, p.id);
      pinned.add(p.userId);
    }
  }
  for (const l of snap.layouts) {
    const next = moveLayout(l.json, from, to);
    if (next === null) continue;
    homes++;
    add("UPDATE home_layouts SET json = ?, updated_at = ? WHERE owner = ?", next, opts.now, l.owner);
  }
  for (const u of snap.userPrefs) {
    const next = moveHomeApps(u.json, from, to);
    if (next === null) continue;
    homes++;
    add("UPDATE user_prefs SET json = ?, updated_at = ? WHERE user_id = ?", next, opts.now, u.userId);
  }
  if (homes) summary.push("Home pins and cards");

  // Monitors: the app's own keeps its history and settings; others that name the app follow it.
  const autoFrom = snap.monitors.find((m) => m.source === "auto" && m.ref === `app:${from}`);
  const autoTo = snap.monitors.find((m) => m.source === "auto" && m.ref === `app:${to}`);
  let monitors = 0;
  const withApp = (config: string) => {
    try {
      return JSON.stringify({ ...JSON.parse(config), app: to });
    } catch {
      return config;
    }
  };
  if (autoFrom && (!autoTo || autoTo.createdAt >= opts.movedAt)) {
    // A monitor the sync made for the new app during the move has no history worth keeping.
    if (autoTo) {
      add("UPDATE findings SET resolved_at = ? WHERE resolved_at IS NULL AND id IN (?, ?)", opts.now, `monitor.down:${autoTo.id}`, `monitor.flapping:${autoTo.id}`);
      add("DELETE FROM monitors WHERE id = ?", autoTo.id);
    }
    add("UPDATE monitors SET ref = ?, config = ? WHERE id = ?", `app:${to}`, withApp(autoFrom.config), autoFrom.id);
    monitors++;
  }
  for (const m of snap.monitors) {
    if (m === autoFrom || m === autoTo) continue;
    let app: unknown;
    try {
      app = JSON.parse(m.config).app;
    } catch {
      continue;
    }
    if (app !== from) continue;
    add("UPDATE monitors SET config = ? WHERE id = ?", withApp(m.config), m.id);
    monitors++;
  }
  if (monitors) summary.push(monitors === 1 ? "its monitor" : `${monitors} monitors`);
  const moved = snap.findings.filter((x) => x.kind.startsWith("monitor."));
  for (const x of moved) add("UPDATE findings SET subject = ? WHERE id = ? AND resolved_at IS NULL", to, x.id);

  for (const id of snap.reports) add("UPDATE reports SET app_id = ? WHERE id = ? AND resolved_at IS NULL", to, id);
  if (snap.reports.length) summary.push(snap.reports.length === 1 ? "an open report" : `${snap.reports.length} open reports`);
  for (const id of snap.announcements) add("UPDATE announcements SET app_id = ? WHERE id = ?", to, id);
  if (snap.announcements.length) summary.push(snap.announcements.length === 1 ? "an announcement" : `${snap.announcements.length} announcements`);
  for (const id of snap.integrations) add("UPDATE integrations SET app_id = ? WHERE id = ?", to, id);
  if (snap.integrations.length) summary.push(snap.integrations.length === 1 ? "its connection for widgets" : `${snap.integrations.length} connections for widgets`);

  if (snap.routes.ids.length || snap.routes.fallback) summary.push(snap.routes.ids.length === 1 ? "its public address" : `${snap.routes.ids.length || 1} public addresses`);
  return { statements: st, routes: snap.routes, summary };
}

// ---------------------------------------------------------------- reading and running

/** What's stored under either id right now. `routes` comes from routes.json. */
export function snapshotRecords(from: string, to: string, routes: { routes: { id: string; app?: string | null }[]; fallback?: { app?: string | null } } | null, now: number): RecordSnapshot {
  const like = `%${JSON.stringify(from).slice(1, -1)}%`;
  return {
    prefs: { from: one<PrefRow>("SELECT * FROM app_prefs WHERE app_id = ?", from) ?? null, to: one<PrefRow>("SELECT * FROM app_prefs WHERE app_id = ?", to) ?? null },
    access: {
      from: all<{ user_id: string }>("SELECT user_id FROM app_access WHERE app_id = ?", from).map((r) => r.user_id),
      to: all<{ user_id: string }>("SELECT user_id FROM app_access WHERE app_id = ?", to).map((r) => r.user_id),
    },
    pins: all<{ id: string; user_id: string; target: string }>("SELECT id, user_id, target FROM pins WHERE kind = 'app' AND target IN (?, ?)", from, to).map((p) => ({ id: p.id, userId: p.user_id, target: p.target })),
    layouts: all<{ owner: string; json: string }>("SELECT owner, json FROM home_layouts WHERE json LIKE ?", like),
    userPrefs: all<{ user_id: string; json: string }>("SELECT user_id, json FROM user_prefs WHERE json LIKE ?", like).map((r) => ({ userId: r.user_id, json: r.json })),
    monitors: all<{ id: string; source: string; ref: string | null; config: string; created_at: number }>("SELECT id, source, ref, config, created_at FROM monitors WHERE ref IN (?, ?) OR config LIKE ?", `app:${from}`, `app:${to}`, like).map((m) => ({ id: m.id, source: m.source, ref: m.ref, config: m.config, createdAt: m.created_at })),
    findings: all<{ id: string; kind: string }>("SELECT id, kind FROM findings WHERE subject = ? AND resolved_at IS NULL", from),
    reports: all<{ id: string }>("SELECT id FROM reports WHERE app_id = ? AND resolved_at IS NULL", from).map((r) => r.id),
    announcements: all<{ id: string }>("SELECT id FROM announcements WHERE app_id = ? AND (until IS NULL OR until > ?)", from, now).map((r) => r.id),
    integrations: all<{ id: string }>("SELECT id FROM integrations WHERE app_id = ?", from).map((r) => r.id),
    routes: { ids: (routes?.routes ?? []).filter((r) => r.app === from).map((r) => r.id), fallback: routes?.fallback?.app === from },
  };
}

/** Run the SQLite part of a plan as one transaction: all of it, or none of it. */
export function applyRecordPlan(plan: RecordPlan): void {
  tx(() => {
    for (const s of plan.statements) run(s.sql, ...s.params);
  });
}
