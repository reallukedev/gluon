import "server-only";
import { activePlatform } from "../platform";
import { findUmbrel } from "../platform/umbrel";
import fs from "node:fs";
import path from "node:path";
import { hostPath, isWithin } from "../host/paths";
import { docker } from "../docker/client";
import { listApps } from "../docker/apps";
import { listPins } from "../pins";
import type { User } from "../auth/users";
import type { Place, PlaceApp, PlaceMedia, Places } from "@/lib/files-types";
import { findByUsername } from "../auth/users";
import { getInventoryState } from "../storage/inventory";
import { canSee, protectionReason, resolveHost, scopeFor } from "./paths";
import { fsInfo, hostMounts, isVirtualFs } from "./mounts";
import { recentFolders } from "./list";

function isDir(p: string): boolean {
  try {
    return fs.statSync(hostPath(p)).isDirectory();
  } catch {
    return false;
  }
}

/** An empty, unmounted folder under /mnt is a leftover mount point, not a place anyone keeps files. */
function isEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(hostPath(p)).length === 0;
  } catch {
    return false;
  }
}

function children(p: string): string[] {
  try {
    return fs
      .readdirSync(hostPath(p), { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith(".") && d.name !== "lost+found")
      .map((d) => path.posix.join(p, d.name))
      .sort();
  } catch {
    return [];
  }
}

const MEDIA_RE = /(^|\/)(media|movies?|films?|tv|shows?|series|music|audio|podcasts?|audiobooks?|books?|ebooks?|comics?|photos?|pictures?|images|gallery|videos?|downloads?|torrents?|library|libraries|upload|recordings?|share|shares|nas|storage)(\/|$)/i;
const NOT_MEDIA_RE = /(^|\/)(appdata|config|configs|cache|db|database|data\/db|pgdata|postgres|mysql|redis|logs?|tmp|state|secrets?|certs?|ssl)(\/|$)/i;

interface Bind {
  source: string;
  destination: string;
  app: PlaceApp;
}

interface MediaFolder {
  path: string;
  apps: Map<string, PlaceApp>;
}

let bindCache: { at: number; value: Promise<Bind[]> } | null = null;

/** Every host folder a container bind-mounts, with the app it belongs to. Cached for a minute. */
function binds(): Promise<Bind[]> {
  if (bindCache && Date.now() - bindCache.at < 60_000) return bindCache.value;
  const value = (async () => {
    const [containers, apps] = await Promise.all([docker().listContainers({ all: true }), listApps().catch(() => [])]);
    const appOf = new Map<string, PlaceApp>();
    for (const a of apps) for (const c of a.containers) appOf.set(c.id, { id: a.id, name: a.name, icon: a.icon });
    const out: Bind[] = [];
    for (const c of containers) {
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      const app = appOf.get(c.Id) ?? { id: name, name, icon: null };
      for (const m of c.Mounts ?? []) {
        if (m.Type !== "bind" || !m.Source?.startsWith("/")) continue;
        out.push({ source: m.Source.replace(/\/+$/, "") || "/", destination: m.Destination, app });
      }
    }
    return out;
  })();
  bindCache = { at: Date.now(), value };
  value.catch(() => (bindCache = null));
  return value;
}

/** Folders apps use for media, found from containers' bind mounts (e.g. Jellyfin's /Media). */
export async function mediaFolders(): Promise<MediaFolder[]> {
  const found = new Map<string, MediaFolder>();
  for (const b of await binds()) {
    const src = b.source;
    if (src === "/" || NOT_MEDIA_RE.test(src) || NOT_MEDIA_RE.test(b.destination)) continue;
    if (!MEDIA_RE.test(src) && !MEDIA_RE.test(b.destination)) continue;
    if (await protectionReason(src)) continue;
    if (!isDir(src)) continue;
    const f = found.get(src) ?? { path: src, apps: new Map<string, PlaceApp>() };
    f.apps.set(b.app.id, b.app);
    found.set(src, f);
  }
  // Keep the outermost folder when one media mount sits inside another.
  const list = [...found.values()].sort((a, b) => a.path.length - b.path.length);
  const out: MediaFolder[] = [];
  for (const f of list) {
    const parent = out.find((o) => isWithin(f.path, o.path));
    if (parent) f.apps.forEach((a, id) => parent.apps.set(id, a));
    else out.push(f);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Apps that keep any folder inside `p`. */
async function appsWithin(p: string): Promise<PlaceApp[]> {
  const byId = new Map<string, PlaceApp>();
  try {
    for (const b of await binds()) if (isWithin(b.source, p) && b.source !== "/") byId.set(b.app.id, b.app);
  } catch {
    /* docker down */
  }
  return sortApps(byId.values());
}

const sortApps = (apps: Iterable<PlaceApp>) => [...apps].sort((a, b) => a.name.localeCompare(b.name));

function labelFor(p: string) {
  return path.posix.basename(p) || p;
}

interface DriveName {
  label: string;
  detail: string | null;
  media: PlaceMedia;
}

/**
 * Human names for mount points, from the storage inventory: a drive that holds one filesystem is
 * called by what it is ("2.0 TB hard drive"); a partition of a bigger disk keeps its folder name and
 * says which disk it is part of.
 */
async function driveNames(): Promise<Map<string, DriveName>> {
  const out = new Map<string, DriveName>();
  let inv: Awaited<ReturnType<typeof getInventoryState>>;
  try {
    inv = await getInventoryState();
  } catch {
    return out;
  }
  const byDisk = new Map<string, string[]>();
  for (const r of inv.volumes) {
    const m = r.vol.primaryMount;
    if (!m || r.vol.role !== "filesystem" || m.startsWith("/boot")) continue;
    byDisk.set(r.disk.id, [...(byDisk.get(r.disk.id) ?? []), m]);
  }
  const titles = new Map<string, number>();
  for (const d of inv.view.disks) if ((byDisk.get(d.id)?.length ?? 0) === 1) titles.set(d.title, (titles.get(d.title) ?? 0) + 1);
  for (const d of inv.view.disks) {
    const mounts = byDisk.get(d.id) ?? [];
    for (const m of mounts) {
      if (m === "/") {
        out.set(m, { label: "Computer", detail: `The system, on the ${d.title}`, media: d.media });
      } else if (mounts.length === 1) {
        const dup = (titles.get(d.title) ?? 0) > 1;
        out.set(m, { label: dup ? `${d.title} · ${labelFor(m)}` : d.title, detail: d.model, media: d.media });
      } else {
        out.set(m, { label: labelFor(m), detail: `Part of the ${d.title}`, media: d.media });
      }
    }
  }
  return out;
}

export async function places(user: User): Promise<Places> {
  const scope = await scopeFor(user);
  const out: Place[] = [];
  const seen = new Set<string>();
  const add = (pl: Place) => {
    if (seen.has(pl.path)) return;
    seen.add(pl.path);
    out.push(pl);
  };

  if (scope.admin) {
    const [names, media] = await Promise.all([driveNames(), mediaFolders().catch(() => [] as MediaFolder[])]);
    const root = names.get("/");
    add({ id: "root", label: "Computer", path: "/", kind: "root", section: "drives", access: "write", fs: fsInfo("/"), detail: root?.detail ?? "Every folder on the server", media: root?.media ?? null });
    // Drives: every real filesystem mounted somewhere people keep data.
    const mounts = hostMounts().filter((m) => !isVirtualFs(m.fstype) && m.root === "/");
    const dataMounts = mounts.filter((m) => /^\/(mnt|media|srv|DATA|data|storage|tank|pool)(\/|$)/.test(m.mount)).map((m) => m.mount);
    const mntDirs = [...children("/mnt"), ...children("/media")];
    for (const p of [...new Set([...mntDirs, ...dataMounts])].sort()) {
      const mounted = mounts.some((m) => m.mount === p);
      if (!mounted && isEmptyDir(p)) continue;
      const n = names.get(p);
      add({
        id: `drive:${p}`,
        label: n?.label ?? labelFor(p),
        path: p,
        kind: "drive",
        section: "drives",
        access: "write",
        fs: mounted ? fsInfo(p) : null,
        detail: mounted ? (n?.detail ?? null) : "Not connected",
        media: n?.media ?? null,
      });
    }
    for (const p of children("/home")) {
      const who = findByUsername(path.posix.basename(p));
      add({ id: `home:${p}`, label: who ? who.display_name : labelFor(p), path: p, kind: "home", section: "homes", access: "write", detail: who ? path.posix.basename(p) : "Home folder" });
    }
    // Working with Umbrel: its Files app keeps Documents, Downloads, Photos and Videos here.
    if ((await activePlatform()) === "umbrel") {
      const ub = await findUmbrel().catch(() => null);
      if (ub && isDir(`${ub.dataDir}/home`)) add({ id: `umbrel:${ub.dataDir}`, label: "Umbrel files", path: `${ub.dataDir}/home`, kind: "home", section: "homes", access: "write", detail: "What Umbrel's Files app shows" });
    }
    for (const m of media) {
      const apps = sortApps(m.apps.values());
      add({ id: `media:${m.path}`, label: labelFor(m.path), path: m.path, kind: "media", section: "apps", access: "write", apps, detail: apps.map((a) => a.name).join(", ") });
    }
    for (const p of ["/srv", "/DATA", "/data", "/opt"]) {
      if (!isDir(p) || seen.has(p)) continue;
      const apps = await appsWithin(p);
      add({ id: `data:${p}`, label: labelFor(p), path: p, kind: "data", section: "apps", access: "write", fs: fsInfo(p), apps, detail: apps.length ? `App data for ${apps.length === 1 ? apps[0]!.name : `${apps.length} apps`}` : "Server folder" });
    }
  } else {
    for (const r of scope.roots) {
      add({ id: `grant:${r.id}`, label: r.label, path: r.path, kind: "grant", section: "shared", access: r.access, missing: r.missing, fs: r.missing ? null : fsInfo(r.real), detail: r.missing ? "Missing" : r.access === "write" ? "Can add and change" : "View only" });
    }
  }

  // Two places called "upload" tell you nothing; show enough of the path to tell them apart.
  const byLabel = new Map<string, Place[]>();
  for (const pl of out) byLabel.set(pl.label, [...(byLabel.get(pl.label) ?? []), pl]);
  for (const group of byLabel.values()) {
    if (group.length < 2 || group.some((pl) => pl.kind === "grant")) continue;
    for (const pl of group) pl.label = `${path.posix.basename(path.posix.dirname(pl.path))}/${pl.label}`;
  }

  const pinsList = listPins(user.id, "folder");
  const pinByTarget = new Map(pinsList.map((p) => [p.target, p]));
  for (const pl of out) {
    const pin = pinByTarget.get(pl.path);
    pl.pinned = pin ? { id: pin.id } : null;
  }

  const pins: Place[] = [];
  for (const p of pinsList) {
    let missing = true;
    let visible = scope.admin;
    try {
      const r = await resolveHost(p.target);
      missing = !r.exists || !r.stat?.isDirectory();
      visible = canSee(scope, r.real);
    } catch {
      /* treat as missing */
    }
    if (!visible) continue;
    pins.push({ id: `pin:${p.id}`, label: p.label, path: p.target, kind: "pin", section: "pins", access: "read", pinned: { id: p.id }, missing });
  }

  const recent: Place[] = [];
  for (const r of recentFolders(user.id, 20)) {
    if (recent.length >= 8) break;
    try {
      const res = await resolveHost(r.path);
      if (!res.exists || !canSee(scope, res.real)) continue;
    } catch {
      continue;
    }
    recent.push({ id: `recent:${r.path}`, label: r.path === "/" ? "Computer" : labelFor(r.path), path: r.path, kind: "recent", section: "recent", access: "read", pinned: pinByTarget.has(r.path) ? { id: pinByTarget.get(r.path)!.id } : null });
  }

  return { places: out, pins, recent, admin: scope.admin };
}
