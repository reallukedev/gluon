import "server-only";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { docker } from "../docker/client";
import { host } from "../host/exec";
import { hostPath } from "../host/paths";
import type { RuntimeMount, ServiceRuntime, VolumeInfo } from "./rewrite";
import type { Measured } from "./plan";

/** Reads from the server that the move and uninstall plans are built from. All read-only. */

export async function inspectAll(ids: string[]): Promise<Docker.ContainerInspectInfo[]> {
  const out = await Promise.all(ids.map((id) => docker().getContainer(id).inspect().catch(() => null)));
  return out.filter((x): x is Docker.ContainerInspectInfo => !!x);
}

export function runtimeOf(i: Docker.ContainerInspectInfo): ServiceRuntime {
  return {
    service: i.Config.Labels?.["com.docker.compose.service"] ?? i.Name.replace(/^\//, ""),
    container: i.Name.replace(/^\//, ""),
    mounts: mountsOf(i),
    env: i.Config.Env ?? [],
    hostname: i.Config.Hostname,
  };
}

export function mountsOf(i: Pick<Docker.ContainerInspectInfo, "Mounts">): RuntimeMount[] {
  return (i.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, name: m.Name, rw: m.RW }));
}

/** Every volume, with the containers that mount it. */
export async function volumeInfo(all?: Docker.ContainerInfo[]): Promise<VolumeInfo[]> {
  const [vols, cs] = await Promise.all([docker().listVolumes().catch(() => ({ Volumes: [] as Docker.VolumeInspectInfo[] })), all ? Promise.resolve(all) : docker().listContainers({ all: true })]);
  const users = new Map<string, string[]>();
  for (const c of cs) {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    for (const m of c.Mounts ?? []) if (m.Type === "volume" && m.Name) users.set(m.Name, [...(users.get(m.Name) ?? []), name]);
  }
  return (vols.Volumes ?? []).map((v) => ({
    name: v.Name,
    mountpoint: v.Mountpoint,
    driver: v.Driver,
    hasOptions: !!v.Options && Object.keys(v.Options).length > 0,
    usedBy: users.get(v.Name) ?? [],
  }));
}

/** Bytes under a path (`du -sb`), or null if it took too long. */
export async function sizeOf(p: string, timeoutMs = 120_000): Promise<number | null> {
  try {
    const { stdout } = await host("du", ["-sb", "--", p], { timeoutMs, okCodes: [1] });
    const n = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function measure(paths: string[], limit = 4): Promise<Map<string, Measured>> {
  const out = new Map<string, Measured>();
  const queue = [...new Set(paths)];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        let st: fs.Stats | null = null;
        try {
          st = fs.statSync(hostPath(p));
        } catch {
          out.set(p, { size: 0, missing: true, file: false });
          continue;
        }
        out.set(p, { size: st.isFile() ? st.size : await sizeOf(p), missing: false, file: st.isFile() });
      }
    }),
  );
  return out;
}

/** Free bytes on the filesystem that holds `p` (or its nearest existing parent). */
export async function freeSpace(p: string): Promise<number | null> {
  let at = p;
  while (at !== "/" && !fs.existsSync(hostPath(at))) at = path.posix.dirname(at);
  try {
    const { stdout } = await host("df", ["-B1", "--output=avail", "--", at], { timeoutMs: 10_000 });
    const n = Number(stdout.trim().split("\n").pop()?.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function readText(p: string): string | null {
  try {
    return fs.readFileSync(hostPath(p), "utf8");
  } catch {
    return null;
  }
}

/** Every bind mount on the server and the container that has it. */
export function bindUses(list: Docker.ContainerInfo[]): { source: string; container: string }[] {
  return list.flatMap((c) => (c.Mounts ?? []).filter((m) => m.Type === "bind" && m.Source).map((m) => ({ source: m.Source, container: (c.Names?.[0] ?? c.Id).replace(/^\//, "") })));
}
