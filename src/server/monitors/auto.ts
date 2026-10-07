import "server-only";
import { all, now } from "../db";
import { tryReadConfig, routeUrl, isRedirect } from "../caddy/routes";
import { listApps, type AppSummary } from "../docker/apps";
import { monitorConfigSchema, type MonitorConfig } from "@/lib/alerts-types";
import { deleteMonitorRow, insertMonitor, listMonitorRows, updateMonitorRow } from "./store";
import { clearFindings, invalidateMonitors } from "./runner";

/**
 * Automatic monitors: one per enabled public address (checked through its public URL, so DNS,
 * certificates, Caddy and the router are all covered) and one per app with a web port (checked on
 * the LAN side at 127.0.0.1, since Gluon shares the host network). Kept in step with the routes
 * file and Docker; the person can pause them or tune timing, but not retarget them.
 */

interface Desired {
  name: string;
  target: string;
  /** Config fields owned by the sync (overwritten every time). */
  derived: Pick<MonitorConfig, "method" | "expectStatus" | "followRedirects" | "ignoreTls" | "severity" | "app" | "keyword" | "keywordAbsent">;
}

/** Things disappear briefly (compose recreate, routes file mid-write); wait before deleting history. */
const REMOVE_GRACE_MS = 10 * 60_000;

type G = typeof globalThis & { __gluonAutoMissing?: Map<string, number> };
const g = globalThis as G;
const missing = () => (g.__gluonAutoMissing ??= new Map());

/** Any HTTP answer below 500 means the app (or its login page) is there. */
const ANY_ANSWER = { min: 200, max: 499 };

function lanTarget(app: AppSummary): string | null {
  const port = app.webPort;
  if (!port) return null;
  let scheme = "http";
  try {
    const home = app.urls.home ? new URL(app.urls.home) : null;
    if (home && Number(home.port || (home.protocol === "https:" ? 443 : 80)) === port && home.protocol === "https:") scheme = "https";
  } catch {
    /* keep http */
  }
  const mapping = app.containers.flatMap((c) => c.ports).find((p) => p.host === port && p.proto === "tcp");
  let hostIp = "127.0.0.1";
  if (mapping?.ip && mapping.ip !== "0.0.0.0" && mapping.ip !== "::") hostIp = mapping.ip.includes(":") ? `[${mapping.ip}]` : mapping.ip;
  return `${scheme}://${hostIp}:${port}/`;
}

function sameDerived(cur: MonitorConfig, d: Desired["derived"]): boolean {
  return (
    cur.method === d.method &&
    cur.expectStatus.min === d.expectStatus.min &&
    cur.expectStatus.max === d.expectStatus.max &&
    cur.followRedirects === d.followRedirects &&
    cur.ignoreTls === d.ignoreTls &&
    cur.severity === d.severity &&
    cur.app === d.app &&
    cur.keyword === d.keyword &&
    cur.keywordAbsent === d.keywordAbsent
  );
}

let syncing = false;
export async function syncAutoMonitors(): Promise<{ created: number; updated: number; removed: number }> {
  const stats = { created: 0, updated: 0, removed: 0 };
  if (syncing) return stats;
  syncing = true;
  try {
    const routesCfg = tryReadConfig();
    let apps: AppSummary[] = [];
    let appsOk = false;
    try {
      apps = await listApps();
      appsOk = true;
    } catch {
      /* Docker unavailable: keep app monitors as they are */
    }
    const granted = new Set(all<{ app_id: string }>("SELECT DISTINCT app_id FROM app_access").map((r) => r.app_id));
    const wanted = new Map<string, Desired>();

    if (routesCfg) {
      for (const r of routesCfg.routes ?? []) {
        if (isRedirect(r) || r.enabled === false) continue;
        const app = (r.app ? apps.find((a) => a.id === r.app) : null) ?? apps.find((a) => a.routes.some((x) => x.id === r.id)) ?? null;
        let url = routeUrl(routesCfg, r);
        if (r.type === "subdomain" && r.only_paths?.length) {
          // Only some paths are published; check the first one (without its wildcard).
          const p = r.only_paths[0]!.replace(/\*.*$/, "");
          url += p.startsWith("/") ? p : `/${p}`;
        }
        wanted.set(`route:${r.id}`, {
          name: `${r.name} (public)`,
          target: url,
          derived: { method: "GET", expectStatus: ANY_ANSWER, followRedirects: false, ignoreTls: false, severity: "fault", app: app?.id ?? r.app ?? null, keyword: null, keywordAbsent: false },
        });
      }
    }
    if (appsOk) {
      for (const a of apps) {
        if (a.self) continue;
        const target = lanTarget(a);
        if (!target) continue;
        const household = a.household || granted.has(a.id);
        wanted.set(`app:${a.id}`, {
          name: a.name,
          target,
          derived: { method: "GET", expectStatus: ANY_ANSWER, followRedirects: false, ignoreTls: true, severity: household ? "fault" : "attention", app: a.id, keyword: null, keywordAbsent: false },
        });
      }
    }

    const existing = listMonitorRows().filter((m) => m.source === "auto");
    const byRef = new Map(existing.map((m) => [m.ref ?? "", m]));
    for (const [ref, d] of wanted) {
      missing().delete(ref);
      const cur = byRef.get(ref);
      if (!cur) {
        const config = monitorConfigSchema.parse({ ...d.derived, intervalSec: 60, timeoutSec: 10, failAfter: ref.startsWith("route:") ? 3 : 2 });
        insertMonitor({ name: d.name, kind: "http", target: d.target, config, source: "auto", ref, enabled: true });
        stats.created++;
      } else if (cur.name !== d.name || cur.target !== d.target || cur.kind !== "http" || !sameDerived(cur.config, d.derived)) {
        updateMonitorRow(cur.id, { name: d.name, target: d.target, kind: "http", config: { ...cur.config, ...d.derived } });
        stats.updated++;
      }
    }
    const t = now();
    for (const m of existing) {
      const ref = m.ref ?? "";
      if (wanted.has(ref)) continue;
      const isRoute = ref.startsWith("route:");
      if ((isRoute && !routesCfg) || (!isRoute && !appsOk)) continue; // source unreadable: don't guess
      const since = missing().get(ref) ?? t;
      missing().set(ref, since);
      if (t - since < REMOVE_GRACE_MS) continue;
      clearFindings(m.id, `${m.name} is no longer monitored`);
      deleteMonitorRow(m.id);
      missing().delete(ref);
      stats.removed++;
    }
    if (stats.created || stats.updated || stats.removed) invalidateMonitors();
    return stats;
  } finally {
    syncing = false;
  }
}
