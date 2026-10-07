import "server-only";
import fs from "node:fs";
import path from "node:path";
import { hostExists, hostPath } from "../host/paths";
import { activePlatform } from "../platform";
import { findUmbrel } from "../platform/umbrel";

/**
 * Where Gluon keeps the apps it runs itself, one folder per app.
 *
 * 1. GLUON_APPS_DIR, when set.
 * 2. A folder that already holds Gluon's apps, so apps never get split across two places.
 * 3. With Umbrel: next to Umbrel's own data (/srv/umbrel → /srv/gluon-apps). That's the disk Umbrel
 *    apps' data is on, so moving one is a copy within one disk, and on this kind of setup the system
 *    disk (where /DATA/AppData usually is) is the small one.
 * 4. /DATA/AppData/gluon-apps where CasaOS's folder exists, else /opt/gluon/apps.
 */

export interface RootFacts {
  env: string | undefined;
  /** Candidate roots that already hold at least one app with a .gluon-app marker, in priority order. */
  populated: string[];
  umbrelDataDir: string | null;
  hasDataAppData: boolean;
}

const VALID = /^\/[A-Za-z0-9._/-]+$/;

export function pickRoot(f: RootFacts): string {
  if (f.env && VALID.test(f.env) && !f.env.includes("..")) return f.env.replace(/\/+$/, "");
  if (f.populated.length) return f.populated[0]!;
  if (f.umbrelDataDir) {
    const parent = path.posix.dirname(f.umbrelDataDir);
    if (parent !== "/" && VALID.test(parent)) return `${parent}/gluon-apps`;
  }
  return f.hasDataAppData ? "/DATA/AppData/gluon-apps" : "/opt/gluon/apps";
}

/** Every place Gluon has kept apps, for finding an app's folder after the default moved. */
export function candidateRoots(umbrelDataDir: string | null): string[] {
  const out = ["/DATA/AppData/gluon-apps", "/opt/gluon/apps"];
  if (umbrelDataDir && path.posix.dirname(umbrelDataDir) !== "/") out.unshift(`${path.posix.dirname(umbrelDataDir)}/gluon-apps`);
  const env = process.env.GLUON_APPS_DIR;
  if (env && VALID.test(env) && !env.includes("..")) out.unshift(env.replace(/\/+$/, ""));
  return [...new Set(out)];
}

function holdsApps(root: string): boolean {
  try {
    return fs.readdirSync(hostPath(root), { withFileTypes: true }).some((d) => d.isDirectory() && fs.existsSync(hostPath(`${root}/${d.name}/.gluon-app`)));
  } catch {
    return false;
  }
}

type G = typeof globalThis & { __gluonAppsRoot?: { at: number; value: string; roots: string[] } };
const g = globalThis as G;

async function umbrelDir(): Promise<string | null> {
  if ((await activePlatform().catch(() => "none")) !== "umbrel") return null;
  return (await findUmbrel().catch(() => null))?.dataDir ?? null;
}

/** The apps root (cached a minute) and every root an existing app might be in. */
export async function appsRoots(): Promise<{ root: string; roots: string[] }> {
  const c = g.__gluonAppsRoot;
  if (c && Date.now() - c.at < 60_000) return { root: c.value, roots: c.roots };
  const dataDir = await umbrelDir();
  const roots = candidateRoots(dataDir);
  const value = pickRoot({ env: process.env.GLUON_APPS_DIR, populated: roots.filter(holdsApps), umbrelDataDir: dataDir, hasDataAppData: hostExists("/DATA/AppData") });
  if (!roots.includes(value)) roots.unshift(value);
  g.__gluonAppsRoot = { at: Date.now(), value, roots };
  return { root: value, roots };
}

export async function appsRoot(): Promise<string> {
  return (await appsRoots()).root;
}

/** Forget the cached root (after the first app lands in a new one). */
export function invalidateAppsRoot() {
  g.__gluonAppsRoot = undefined;
}

/**
 * The folder for app `name`: an existing one whose marker belongs to `owner` (in any root), else
 * a new one in the current root.
 */
export async function appFolder(name: string, owns: (marker: string) => boolean): Promise<string> {
  const { root, roots } = await appsRoots();
  for (const r of roots) {
    const dir = `${r}/${name}`;
    try {
      if (owns(fs.readFileSync(hostPath(`${dir}/.gluon-app`), "utf8").trim())) return dir;
    } catch {
      /* not there */
    }
  }
  return `${root}/${name}`;
}
