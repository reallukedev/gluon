import "server-only";
import fs from "node:fs";
import path from "node:path";
import { hostExists, hostPath } from "../host/paths";
import { activePlatform } from "../platform";
import { findUmbrel } from "../platform/umbrel";

/**
 * GLUON_APPS_DIR, else a folder that already holds Gluon's apps (so they never split across two
 * places), else next to Umbrel's data (its disk is the big one, and moves stay on one disk), else
 * /DATA/AppData/gluon-apps where CasaOS exists, else /opt/gluon/apps.
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

/** Root cached a minute. */
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

export function invalidateAppsRoot() {
  g.__gluonAppsRoot = undefined;
}

/** An existing folder whose marker belongs to `owner` (in any root), else a new one in the current root. */
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
