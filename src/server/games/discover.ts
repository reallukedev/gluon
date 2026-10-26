import "server-only";
import type Docker from "dockerode";
import { docker } from "../docker/client";

/**
 * Finding mc-router and Crafty by looking at what's running, not by assuming paths: the routes
 * file is wherever mc-router's ROUTES_CONFIG points, mapped through its mounts to this server's
 * filesystem, and Crafty's servers folder is wherever its /crafty/servers is mounted from.
 */

export type Listed = Docker.ContainerInfo;

export const nameOf = (c: Pick<Listed, "Names">) => (c.Names[0] ?? "").replace(/^\//, "");

/** Every name other containers on a shared network can use for this one (aliases come from inspecting it). */
export function dnsNames(c: Listed, aliases: Map<string, string[]> = new Map()): string[] {
  const out = new Set<string>([nameOf(c), c.Id.slice(0, 12), ...(aliases.get(c.Id) ?? [])]);
  const svc = c.Labels?.["com.docker.compose.service"];
  if (svc) out.add(svc);
  for (const n of Object.values(c.NetworkSettings?.Networks ?? {})) for (const a of (n.Aliases as string[] | null) ?? []) out.add(a);
  return [...out].filter(Boolean);
}

export const networksOf = (c: Listed) => Object.keys(c.NetworkSettings?.Networks ?? {});

export const isMcRouter = (c: Listed) => /(^|\/)itzg\/mc-router([:@]|$)/.test(c.Image) || nameOf(c) === "mc-router";
export const isCrafty = (c: Listed) =>
  /crafty-controller\/crafty-4|(^|\/)crafty-4([:@]|$)/.test(c.Image) ||
  nameOf(c) === "crafty_container" ||
  (c.Labels?.["com.docker.compose.project"] === "crafty" && c.Labels?.["com.docker.compose.service"] === "crafty") ||
  // Crafty's layout, whatever the image is called.
  (c.Mounts ?? []).some((m) => m.Destination === "/crafty/servers");

/** A container path through the container's mounts to the path on this server, or null when it isn't mounted. */
export function hostPathFor(mounts: { Source: string; Destination: string }[], containerPath: string): string | null {
  const m = mounts
    .filter((x) => containerPath === x.Destination || containerPath.startsWith(x.Destination.replace(/\/$/, "") + "/"))
    .sort((a, b) => b.Destination.length - a.Destination.length)[0];
  if (!m || !m.Source) return null;
  return m.Source.replace(/\/$/, "") + containerPath.slice(m.Destination.replace(/\/$/, "").length);
}

/**
 * mc-router's settings from its environment and command line (flags win, as in mc-router).
 * Flags look like -routes-config=/x, --routes-config /x or -routes-config-watch.
 */
export function routerSettings(env: string[], args: string[]): { routesConfig: string | null; watch: boolean; port: number; mapping: string | null; fallback: string | null } {
  const e = new Map(env.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as [string, string]));
  const flag = (name: string): string | true | null => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!.replace(/^--?/, "-");
      if (a === `-${name}`) return args[i + 1] && !args[i + 1]!.startsWith("-") ? args[i + 1]! : true;
      if (a.startsWith(`-${name}=`)) return a.slice(name.length + 2);
    }
    return null;
  };
  const get = (name: string, envName: string) => {
    const f = flag(name);
    return f === null ? (e.get(envName) ?? null) : f === true ? "true" : f;
  };
  const truthy = (v: string | null) => !!v && /^(1|true|yes|on)$/i.test(v);
  return {
    routesConfig: get("routes-config", "ROUTES_CONFIG") || null,
    watch: truthy(get("routes-config-watch", "ROUTES_CONFIG_WATCH")),
    port: Number(get("port", "PORT")) || 25565,
    mapping: get("mapping", "MAPPING") || null,
    fallback: get("default", "DEFAULT") || null,
  };
}

/** MAPPING's "host=backend,host=backend" (also newline separated). */
export function parseMappingEnv(v: string): [string, string][] {
  return v
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => [p.slice(0, p.indexOf("=")).trim(), p.slice(p.indexOf("=") + 1).trim()] as [string, string]);
}

export async function listContainers(): Promise<Listed[]> {
  return docker().listContainers({ all: true });
}

/**
 * Network aliases (compose's service names, --network-alias) only show when a container is
 * inspected. Done for the ones on mc-router's networks and for Crafty, which is all mc-router can reach.
 */
export async function networkAliases(list: Listed[], networks: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const wanted = list.filter((c) => isCrafty(c) || networksOf(c).some((n) => networks.includes(n))).slice(0, 40);
  await Promise.all(
    wanted.map(async (c) => {
      try {
        const info = await docker().getContainer(c.Id).inspect();
        const names = Object.values(info.NetworkSettings?.Networks ?? {}).flatMap((n) => [...((n.Aliases as string[] | null) ?? []), ...(((n as { DNSNames?: string[] | null }).DNSNames) ?? [])]);
        out.set(c.Id, [...new Set(names)]);
      } catch {
        /* gone since the list */
      }
    }),
  );
  return out;
}
