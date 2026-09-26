import "server-only";
import fs from "node:fs";
import net from "node:net";
import { docker } from "../docker/client";
import { listApps } from "../docker/apps";
import { isHomeIp } from "../net-zone";
import type { AddrScope, Owner } from "@/lib/diagnostics-types";

/**
 * Who owns a process, a socket or an address: which container (and app), which systemd unit.
 * Used by the connections view, the process list and the exposure audit.
 *
 * With `pid: host`, /proc here is the host's /proc, so /proc/<pid>/cgroup tells us the container
 * (cgroup v2: `0::/system.slice/docker-<id>.scope`).
 */

export interface ContainerMeta {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  image: string;
  pid: number;
  hostNet: boolean;
  ips: string[];
  ports: { host: number; container: number; proto: "tcp" | "udp"; ip: string }[];
  appId: string | null;
  appName: string | null;
}

export interface DockerNetwork {
  id: string;
  name: string;
  bridge: string | null;
  subnets: string[];
  gateways: string[];
}

interface Index {
  at: number;
  byId: Map<string, ContainerMeta>;
  byName: Map<string, ContainerMeta>;
  byIp: Map<string, ContainerMeta>;
  list: ContainerMeta[];
}

type G = typeof globalThis & {
  __gluonAttrib?: {
    index: Index | null;
    building: Promise<Index> | null;
    pids: Map<string, number>;
    networks: { at: number; list: DockerNetwork[]; block: net.BlockList } | null;
    owners: Map<number, { at: number; owner: Owner; start: string }>;
  };
};
const g = globalThis as G;
const st = () => (g.__gluonAttrib ??= { index: null, building: null, pids: new Map(), networks: null, owners: new Map() });

const read = (p: string) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** Container id from /proc/<pid>/cgroup, or the systemd unit for host services. */
export function cgroupOf(pid: number): { containerId: string | null; unit: string | null } {
  const text = read(`/proc/${pid}/cgroup`);
  if (!text) return { containerId: null, unit: null };
  const m = text.match(/docker[-/]([0-9a-f]{64})(?:\.scope)?/);
  if (m) return { containerId: m[1]!, unit: null };
  // cgroup v2: "0::/system.slice/casaos-gateway.service"; v1 lines "N:name:/path".
  const unit = text.match(/\/([^/\n]+\.(?:service|scope))\s*$/m)?.[1] ?? null;
  return { containerId: null, unit };
}

async function build(): Promise<Index> {
  const s = st();
  const [list, apps] = await Promise.all([docker().listContainers({ all: false }), listApps().catch(() => [])]);
  const appByContainer = new Map<string, { id: string; name: string }>();
  for (const a of apps) for (const c of a.containers) appByContainer.set(c.id, { id: a.id, name: a.name });

  const idx: Index = { at: Date.now(), byId: new Map(), byName: new Map(), byIp: new Map(), list: [] };
  for (const c of list) {
    let pid = s.pids.get(c.Id) ?? 0;
    // A restarted container keeps its id but gets a new init pid: validate the cached one.
    if (!pid || cgroupOf(pid).containerId !== c.Id) {
      try {
        const info = await docker().getContainer(c.Id).inspect();
        pid = info.State.Pid || 0;
        s.pids.set(c.Id, pid);
      } catch {
        pid = 0;
      }
    }
    const nets = (c.NetworkSettings?.Networks ?? {}) as Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
    const ips = Object.values(nets).flatMap((n) => [n.IPAddress, n.GlobalIPv6Address].filter((x): x is string => !!x));
    const app = appByContainer.get(c.Id) ?? null;
    const meta: ContainerMeta = {
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
      project: c.Labels?.["com.docker.compose.project"] ?? null,
      service: c.Labels?.["com.docker.compose.service"] ?? null,
      image: c.Image,
      pid,
      hostNet: c.HostConfig?.NetworkMode === "host",
      ips,
      ports: (c.Ports ?? [])
        .filter((p) => p.PublicPort)
        .map((p) => ({ host: p.PublicPort, container: p.PrivatePort, proto: (p.Type === "udp" ? "udp" : "tcp") as "tcp" | "udp", ip: p.IP ?? "" })),
      appId: app?.id ?? null,
      appName: app?.name ?? null,
    };
    idx.byId.set(meta.id, meta);
    idx.byName.set(meta.name, meta);
    for (const ip of ips) idx.byIp.set(ip, meta);
    idx.list.push(meta);
  }
  for (const id of s.pids.keys()) if (!idx.byId.has(id)) s.pids.delete(id);
  return idx;
}

/** Running containers with pid, IPs, published ports and app. Cached a few seconds. */
export async function containerIndex(maxAgeMs = 5000): Promise<Index> {
  const s = st();
  if (s.index && Date.now() - s.index.at < maxAgeMs) return s.index;
  if (!s.building) {
    s.building = build()
      .then((i) => (s.index = i))
      .finally(() => {
        s.building = null;
      });
  }
  try {
    return await s.building;
  } catch {
    return s.index ?? { at: 0, byId: new Map(), byName: new Map(), byIp: new Map(), list: [] };
  }
}

/** Docker networks (bridge name, subnets). Cached a minute. */
export async function dockerNetworks(): Promise<{ list: DockerNetwork[]; block: net.BlockList }> {
  const s = st();
  if (s.networks && Date.now() - s.networks.at < 60_000) return s.networks;
  const block = new net.BlockList();
  const list: DockerNetwork[] = [];
  try {
    for (const n of await docker().listNetworks()) {
      const subnets = (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((x): x is string => !!x);
      const gateways = (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((x): x is string => !!x);
      const bridge = n.Options?.["com.docker.network.bridge.name"] ?? (n.Driver === "bridge" ? `br-${n.Id.slice(0, 12)}` : null);
      list.push({ id: n.Id, name: n.Name, bridge, subnets, gateways });
      for (const cidr of subnets) {
        const [addr, bits] = cidr.split("/");
        const type = net.isIPv6(addr ?? "") ? "ipv6" : "ipv4";
        try {
          block.addSubnet(addr!, Number(bits), type);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* docker unavailable */
  }
  s.networks = { at: Date.now(), list, block };
  return s.networks;
}

export function stripMapped(ip: string): string {
  return ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

export function isLoopback(ip: string): boolean {
  const a = stripMapped(ip);
  return a === "::1" || a.startsWith("127.");
}

/** Where an address lives, relative to this machine. */
export function scopeOf(ip: string, dockerBlock: net.BlockList): AddrScope {
  const a = stripMapped(ip);
  if (isLoopback(a)) return "local";
  const type = net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null;
  if (!type) return "internet";
  if (dockerBlock.check(a, type)) return "containers";
  if (isHomeIp(a)) return "lan";
  return "internet";
}

/** docker-proxy forwards a published port to a container: `-container-ip 172.18.0.5 -container-port 8080`. */
export function dockerProxyTarget(pid: number): { ip: string; port: number; hostPort: number | null } | null {
  const cmd = read(`/proc/${pid}/cmdline`);
  if (!cmd) return null;
  const args = cmd.split("\0");
  if (!/docker-proxy$/.test(args[0] ?? "")) return null;
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ip = get("-container-ip");
  const port = Number(get("-container-port"));
  const hostPort = Number(get("-host-port"));
  if (!ip || !port) return null;
  return { ip, port, hostPort: hostPort || null };
}

function containerOwner(m: ContainerMeta): Owner {
  return { kind: "container", id: m.id, name: m.name, appId: m.appId, appName: m.appName };
}

/** Owner of a host pid. docker-proxy processes are attributed to the container they forward to. */
export function ownerOfPid(pid: number, idx: Index): Owner {
  const s = st();
  const stat = read(`/proc/${pid}/stat`) ?? "";
  const start = stat ? (stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "") : "";
  const cached = s.owners.get(pid);
  if (cached && cached.start === start && Date.now() - cached.at < 60_000) return cached.owner;
  let owner: Owner = { kind: "process" };
  const proxy = dockerProxyTarget(pid);
  if (proxy) {
    const m = idx.byIp.get(proxy.ip);
    owner = m ? containerOwner(m) : { kind: "service", unit: "docker.service" };
  } else {
    const cg = cgroupOf(pid);
    if (cg.containerId) {
      const m = idx.byId.get(cg.containerId);
      owner = m ? containerOwner(m) : { kind: "container", id: cg.containerId, name: cg.containerId.slice(0, 12), appId: null, appName: null };
    } else if (cg.unit && !/^session-\d+\.scope$/.test(cg.unit) && cg.unit !== "init.scope") {
      owner = { kind: "service", unit: cg.unit };
    }
  }
  if (!start && !cached) return owner; // process gone; don't cache
  s.owners.set(pid, { at: Date.now(), owner, start });
  if (s.owners.size > 5000) {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of s.owners) if (v.at < cutoff) s.owners.delete(k);
  }
  return owner;
}

export function ownerLabel(owner: Owner, processName?: string | null): string {
  switch (owner.kind) {
    case "container":
      return owner.appName && owner.appName !== owner.name ? `${owner.appName} (${owner.name})` : owner.name;
    case "service":
      return owner.unit.replace(/\.service$/, "");
    default:
      return processName || "unknown";
  }
}

/** Readable name of the network namespace a pid lives in ("net:[4026531840]"). */
export function netnsOf(pid: number | "self"): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return null;
  }
}
