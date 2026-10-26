import "server-only";
import fs from "node:fs";
import { now, run } from "../db";
import { audit } from "../audit";
import { AppError } from "../errors";
import type { User } from "../auth/users";
import { caddyAdmin, coveredByWildcard, httpsMode, routeUrl, SITE_BACKEND, SITE_VERSION_RE, tryReadConfig, type HttpsSettings, type RoutesConfig, type SubdomainRoute } from "../caddy/routes";
import { saveSiteRoutes } from "../network/routes-service";
import type { CertUploads } from "@/lib/network-types";
import { formatBytes, plural } from "@/lib/format";
import { SITE_LIMITS, type SiteDetail, type SiteSummary, type SitesList } from "@/lib/sites-types";
import { cleanSiteName, createSiteRow, deleteSiteRows, draftDir, removeDraft, renameSiteRow, siteRow, siteRows, versionRows, walk, withSite, type SiteRow, type VersionRow } from "./store";
import { addStarter } from "./import";
import { copyToVersion, newVersionName, pruneVersions, removeVersions, versionDir, versionsOnDisk } from "./versions";

/**
 * Sites as people see them: a draft, an address, and the version that address serves. Whether a
 * site is live is read from routes.json every time (someone may have turned the address off on the
 * Network page, or restored an older routes file), never from a copy kept here.
 */

type Where = { ip: string; zone: string };
type SiteRoute = SubdomainRoute & { site: NonNullable<SubdomainRoute["site"]> };

export const routeIdFor = (id: string) => `site-${id}`;

/**
 * The site's route, as long as it's shaped like one. routes.json is edited by hand too, so anything
 * else in it (a null, a route with no host) is ignored instead of breaking the Sites page.
 */
function routeOf(cfg: RoutesConfig | null, id: string): SiteRoute | null {
  const routes: unknown[] = Array.isArray(cfg?.routes) ? cfg!.routes : [];
  const r = routes.find((x): x is SiteRoute => !!x && typeof x === "object" && (x as SiteRoute).type === "subdomain" && (x as SiteRoute).site?.id === id);
  return r ?? null;
}

/** A route Gluon can use: a host and a version name it would have written itself. */
const usable = (r: SiteRoute) => typeof r.host === "string" && HOST_OK.test(r.host) && SITE_VERSION_RE.test(String(r.site.version));
const HOST_OK = /^[a-z0-9.-]{1,253}$/;

function summaryOf(row: SiteRow, cfg: RoutesConfig | null, versions: VersionRow[]): SiteSummary {
  const found = routeOf(cfg, row.id);
  // A route Gluon can't make sense of reads as an address that needs publishing again.
  const route = found && usable(found) ? found : null;
  const liveRow = route ? versions.find((v) => v.version === route.site.version) : undefined;
  let state: SiteSummary["state"] = "draft";
  if (found && !route) state = "broken";
  else if (route) state = route.enabled === false ? "off" : fs.existsSync(versionDir(row.id, route.site.version)) ? "live" : "broken";
  const shown = route ?? (found && typeof found.host === "string" && HOST_OK.test(found.host) ? found : null);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by,
    draft: { files: row.files, bytes: row.bytes, changedAt: row.changed_at, changedBy: row.changed_by, rev: row.draft_rev },
    address:
      shown && cfg
        ? { host: shown.host, url: routeUrl(cfg, shown), https: httpsMode(shown), ...(shown.https ? { httpsSetting: shown.https } : {}), wildcard: coveredByWildcard(shown.host, cfg.base_domain) }
        : null,
    state,
    live: route ? { version: route.site.version, at: row.published_at, by: row.published_by } : null,
    changes: route ? !liveRow || liveRow.draft_rev !== row.draft_rev : row.files > 0,
  };
}

export function listSites(): SitesList {
  const cfg = tryReadConfig();
  return { sites: siteRows().map((r) => summaryOf(r, cfg, versionRows(r.id))), baseDomain: cfg?.base_domain ?? null };
}

export function siteDetail(id: string): SiteDetail {
  const row = siteRow(id);
  const cfg = tryReadConfig();
  const versions = versionRows(id);
  const sum = summaryOf(row, cfg, versions);
  const onDisk = new Set(versionsOnDisk(id));
  return {
    ...sum,
    versions: versions
      .filter((v) => onDisk.has(v.version))
      .map((v) => ({ version: v.version, createdAt: v.created_at, createdBy: v.created_by, files: v.files, bytes: v.bytes, live: sum.live?.version === v.version && sum.state !== "off" })),
    baseDomain: cfg?.base_domain ?? null,
    taken: (Array.isArray(cfg?.routes) ? cfg!.routes : []).filter((r): r is SubdomainRoute => !!r && r.type === "subdomain" && typeof r.host === "string" && r.site?.id !== id).map((r) => ({ host: r.host, name: r.name })),
    addressesUnavailable: cfg ? null : "Can't read the public addresses file, so nothing can be published yet. Check the Network page.",
  };
}

export async function createSite(user: User, where: Where, body: { name: string; start: "starter" | "empty" }): Promise<SiteDetail> {
  const name = cleanSiteName(body.name);
  const row = createSiteRow(user, name);
  if (body.start === "starter") await addStarter(row.id, user, name);
  audit(user, { action: "sites.create", target: name, summary: `Made the site ${name}${body.start === "starter" ? " from the starter page" : ""}` }, where);
  return siteDetail(row.id);
}

export function renameSite(user: User, where: Where, id: string, raw: string): SiteDetail {
  const row = siteRow(id);
  const name = cleanSiteName(raw);
  if (name !== row.name) {
    renameSiteRow(id, name);
    audit(user, { action: "sites.rename", target: name, summary: `Renamed the site ${row.name} to ${name}` }, where);
  }
  return siteDetail(id);
}

function needConfig(): RoutesConfig {
  const cfg = tryReadConfig();
  if (!cfg) throw new AppError("no_routes", "Can't read the public addresses file (routes.json in ~/proxy/caddy), so nothing can be published. Check the Network page.", 503);
  return cfg;
}

export interface PublishInput {
  /** The address. Leave out to publish again at the address it already has. */
  host?: string;
  /** null: Gluon gets a certificate. Leave out to keep what the address has. */
  https?: HttpsSettings | null;
  certs?: CertUploads;
}

/**
 * Publish the draft: copy it into a new version, point the site's address at it through the same
 * checked save as the Network page (Caddy must accept it before anything is saved), and only then
 * record it. If Caddy says no, the new copy is removed and the old version keeps serving.
 */
export function publishSite(user: User, where: Where, id: string, input: PublishInput): Promise<SiteDetail> {
  return withSite(id, async () => {
    const row = siteRow(id);
    const cfg = needConfig();
    const existing = routeOf(cfg, id);
    const host = (input.host ?? (typeof existing?.host === "string" ? existing.host : "")).trim().toLowerCase().replace(/\.$/, "");
    if (!host) throw new AppError("invalid", "Choose the address people will open.", 400, { field: "host" });
    const { files } = walk(draftDir(id));
    if (!files.some((f) => f.path === "index.html")) throw new AppError("no_index", "Add an index.html at the top of the site first. It's the page people see when they open the address.", 400);
    const version = newVersionName(id);
    const copied = copyToVersion(id, draftDir(id), version);
    const https = input.https === undefined ? existing?.https : (input.https ?? undefined);
    const route: SiteRoute = {
      id: existing?.id ?? routeIdFor(id),
      type: "subdomain",
      name: row.name,
      enabled: true,
      host,
      backend: { ...SITE_BACKEND },
      site: { id, version, ...(copied.own404 ? { own_404: true } : {}) },
      ...(https ? { https } : {}),
      ...(existing?.note ? { note: existing.note } : {}),
    };
    const verb = existing && existing.enabled !== false ? "Published changes to" : "Published";
    try {
      await saveSiteRoutes(user, where, (routes) => (routes.some((r) => r.id === route.id) ? routes.map((r) => (r.id === route.id ? route : r)) : [...routes, route]), `Site ${row.name} published by ${user.username} in Gluon`, `${verb} the site ${row.name}`, input.certs ?? {});
    } catch (e) {
      // The save can fail after Caddy took the new config (or after routes.json was written), so the
      // new copy is only removed once it's certain nothing serves it.
      const fate = await servedNow(id, version);
      if (fate !== "saved") {
        if (fate === "not-served") fs.rmSync(versionDir(id, version), { recursive: true, force: true });
        audit(user, { action: "sites.publish", target: host, summary: `Couldn't publish ${row.name} at ${host}: ${(e as Error).message}`, outcome: "failed" }, where);
        throw e;
      }
      // The address points at the new version: the publish took effect even though something after it failed.
    }
    const t = now();
    run("INSERT INTO site_versions (site_id, version, created_at, created_by, draft_rev, files, bytes, own_404) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, version, t, user.username, row.draft_rev, copied.files, copied.bytes, copied.own404 ? 1 : 0);
    run("UPDATE sites SET published_at = ?, published_by = ? WHERE id = ?", t, user.username, id);
    forget(id, pruneVersions(id, SITE_LIMITS.versions, [version]));
    audit(user, { action: "sites.publish", target: host, summary: `${verb} ${row.name} at ${host} (${plural(copied.files, "file")}, ${formatBytes(copied.bytes)})`, detail: { site: id, version, files: copied.files, bytes: copied.bytes } }, where);
    return siteDetail(id);
  });
}

/**
 * Whether anything serves a version after a failed save: routes.json points at it ("saved"),
 * Caddy's running config does ("loaded"), neither does ("not-served"), or Caddy can't be asked
 * ("unknown"). Only "not-served" lets the copy go; any other leftover is cleared by pruning later.
 */
async function servedNow(id: string, version: string): Promise<"saved" | "loaded" | "not-served" | "unknown"> {
  if (routeOf(tryReadConfig(), id)?.site.version === version) return "saved";
  try {
    const r = await caddyAdmin("GET", "/config/");
    if (r.status !== 200) return "unknown";
    return r.body.includes(`/sites/${id}/${version}`) ? "loaded" : "not-served";
  } catch {
    return "unknown";
  }
}

function forget(id: string, versions: string[]) {
  for (const v of versions) run("DELETE FROM site_versions WHERE site_id = ? AND version = ?", id, v);
}

/** Point the address back at an earlier version. The draft stays as it is. */
export function rollbackSite(user: User, where: Where, id: string, version: string): Promise<SiteDetail> {
  return withSite(id, async () => {
    const row = siteRow(id);
    const existing = routeOf(needConfig(), id);
    if (!existing) throw new AppError("not_published", `${row.name} has no address yet. Publish it first.`, 409);
    const dir = versionDir(id, version);
    if (!fs.existsSync(dir)) throw new AppError("not_found", "That version was cleared out already. Only the last few are kept.", 404);
    const own404 = fs.existsSync(`${dir}/404.html`);
    await saveSiteRoutes(
      user,
      where,
      (routes) => routes.map((r) => (r.id === existing.id && r.type === "subdomain" ? { ...r, enabled: true, site: { id, version, ...(own404 ? { own_404: true } : {}) } } : r)),
      `Site ${row.name} rolled back by ${user.username} in Gluon`,
      `Put an earlier version of ${row.name} live`,
    );
    run("UPDATE sites SET published_at = ?, published_by = ? WHERE id = ?", now(), user.username, id);
    audit(user, { action: "sites.rollback", target: existing.host, summary: `Put ${row.name}'s version from ${versionWhen(version)} live at ${existing.host}`, detail: { site: id, version, from: existing.site.version } }, where);
    return siteDetail(id);
  });
}

const versionWhen = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)} ${v.slice(9, 11)}:${v.slice(11, 13)} UTC`;

/** Turn the address off. The site, its address and its versions stay, so publishing again brings it back. */
export function unpublishSite(user: User, where: Where, id: string): Promise<SiteDetail> {
  return withSite(id, async () => {
    const row = siteRow(id);
    const existing = routeOf(needConfig(), id);
    if (!existing || existing.enabled === false) return siteDetail(id);
    await saveSiteRoutes(user, where, (routes) => routes.map((r) => (r.id === existing.id ? { ...r, enabled: false } : r)), `Site ${row.name} unpublished by ${user.username} in Gluon`, `Took the site ${row.name} offline`);
    audit(user, { action: "sites.unpublish", target: existing.host, summary: `Took ${row.name} offline at ${existing.host}` }, where);
    return siteDetail(id);
  });
}

/** Delete the site: its address, every published version and the draft. */
export function deleteSite(user: User, where: Where, id: string): Promise<{ ok: true }> {
  return withSite(id, async () => {
    const row = siteRow(id);
    const cfg = tryReadConfig();
    if (!cfg && versionsOnDisk(id).length) {
      throw new AppError("no_routes", "Can't read the public addresses right now, so this site's address can't be taken down. Fix that on the Network page first.", 503);
    }
    const existing = routeOf(cfg, id);
    if (existing) {
      await saveSiteRoutes(user, where, (routes) => routes.filter((r) => r.id !== existing.id), `Site ${row.name} deleted by ${user.username} in Gluon`, `Removed the site ${row.name}`);
    }
    removeVersions(id);
    removeDraft(id);
    deleteSiteRows(id);
    audit(user, { action: "sites.delete", target: existing?.host ?? row.name, summary: `Deleted the site ${row.name}${existing ? ` and its address ${existing.host}` : ""}`, detail: { site: id, files: row.files, bytes: row.bytes } }, where);
    return { ok: true as const };
  });
}
