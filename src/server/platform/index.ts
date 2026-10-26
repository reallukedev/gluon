import "server-only";
import { getSetting } from "../settings";
import { host } from "../host/exec";
import { hostExists } from "../host/paths";
import { findUmbrel, umbrelVersion } from "./umbrel";

/**
 * The home server OS Gluon works alongside. It decides where apps are installed, updated and
 * removed, which app store Gluon shows, and what the public domain's fallback is called.
 * "auto" picks Umbrel when it's reachable, then CasaOS, then neither (plain Docker).
 */
export type Platform = "umbrel" | "casaos" | "none";
export type PlatformSetting = Platform | "auto";

export interface PlatformInfo {
  setting: PlatformSetting;
  active: Platform;
  umbrel: { found: boolean; version: string | null; url: string | null; container: string | null };
  casaos: { found: boolean; version: string | null };
}

type G = typeof globalThis & { __gluonCasaVersion?: { at: number; value: string | null } };
const g = globalThis as G;

export function casaosInstalled(): boolean {
  return hostExists("/usr/bin/casaos") || hostExists("/var/lib/casaos");
}

async function casaosVersion(): Promise<string | null> {
  const c = g.__gluonCasaVersion;
  if (c && Date.now() - c.at < 10 * 60_000) return c.value;
  const value = hostExists("/usr/bin/casaos")
    ? await host("casaos", ["-v"], { timeoutMs: 5000 })
        .then((r) => r.stdout.trim().match(/v?(\d+\.\d+(?:\.\d+)?\S*)/)?.[1] ?? null)
        .catch(() => null)
    : null;
  g.__gluonCasaVersion = { at: Date.now(), value };
  return value;
}

export async function activePlatform(): Promise<Platform> {
  const setting = getSetting("platform");
  if (setting !== "auto") return setting;
  if (await findUmbrel()) return "umbrel";
  if (casaosInstalled()) return "casaos";
  return "none";
}

export async function platformInfo(): Promise<PlatformInfo> {
  const [ep, active] = await Promise.all([findUmbrel(true), activePlatform()]);
  const [uv, cv] = await Promise.all([ep ? umbrelVersion() : Promise.resolve(null), casaosVersion()]);
  return {
    setting: getSetting("platform"),
    active,
    umbrel: { found: !!ep, version: uv, url: ep?.url ?? null, container: ep?.container ?? null },
    casaos: { found: casaosInstalled(), version: cv },
  };
}

export const PLATFORM_NAME: Record<Platform, string> = { umbrel: "Umbrel", casaos: "CasaOS", none: "Docker" };
