import "server-only";
import { listApps, type AppSummary } from "../../docker/apps";
import { tryReadConfig, routeUrl } from "../../caddy/routes";
import { getInventory } from "../../storage/inventory";
import { FALLBACK_ID } from "../../network/routes-meta";
import type { CheckupState, CheckupTargets } from "@/lib/diagnostics-types";
import { activeRuns } from "./runner";
import { latestFull, recentRuns } from "./history";
import { displayUrl } from "./addresses";

/** What the Checkup tab needs on load: runs in progress, the last full checkup, history and pickers. */

export async function checkupTargets(): Promise<CheckupTargets> {
  const [apps, inv] = await Promise.all([listApps().catch(() => [] as AppSummary[]), getInventory().catch(() => null)]);
  const cfg = tryReadConfig();
  const addresses: CheckupTargets["addresses"] = cfg
    ? [
        { id: FALLBACK_ID, name: cfg.fallback.name, host: cfg.base_domain, url: `https://${cfg.base_domain}/`, enabled: true },
        ...cfg.routes.map((r) => ({ id: r.id, name: r.name, host: r.type === "subdomain" ? r.host : cfg.base_domain, url: routeUrl(cfg, r), enabled: r.enabled !== false })),
      ]
    : [];
  return {
    apps: apps
      .filter((a) => a.webPort || a.routes.length)
      .map((a) => ({ id: a.id, name: a.name, icon: a.icon, running: a.containers.some((c) => c.state === "running") }))
      .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name)),
    addresses: addresses.map((x) => ({ ...x, name: x.name || displayUrl(x.url) })),
    disks: (inv?.disks ?? []).filter((d) => d.mediaPresent).map((d) => ({ id: d.id, title: d.title, model: d.model, name: d.name })),
  };
}

export async function checkupState(): Promise<CheckupState> {
  const targets = await checkupTargets();
  return { active: activeRuns(), latest: latestFull(), recent: recentRuns(20), targets };
}
