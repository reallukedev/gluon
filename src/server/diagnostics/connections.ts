import "server-only";
import fs from "node:fs";
import dns from "node:dns";
import { hostEstablished, hostListeners, procNetSockets, type SsSocket } from "../network/sockets";
import { containerIndex, dockerNetworks, dockerProxyTarget, isLoopback, netnsOf, ownerLabel, ownerOfPid, scopeOf, stripMapped } from "./attribution";
import { sharedPoll } from "./poller";
import type { Connection, ConnectionsSnapshot, Owner } from "@/lib/diagnostics-types";

/**
 * Active connections, attributed to apps.
 *
 * Host namespace: `ss -tunpH state established` (gives the process). Containers with their own
 * network namespace: /proc/<pid>/net/{tcp,udp}{,6} of the container's init process (no spawn per
 * container). Direction: a connection whose local port is a listening port is inbound.
 */

const MAX = 1500;

const readFile = (p: string) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

let listenCache: { at: number; tcp: Set<number>; udp: Set<number> } | null = null;
async function hostListening(): Promise<{ tcp: Set<number>; udp: Set<number> }> {
  if (listenCache && Date.now() - listenCache.at < 15_000) return listenCache;
  const tcp = new Set<number>();
  const udp = new Set<number>();
  try {
    for (const s of await hostListeners()) (s.proto === "tcp" ? tcp : udp).add(s.local.port);
  } catch {
    /* keep empty */
  }
  listenCache = { at: Date.now(), tcp, udp };
  return listenCache;
}

// ---------------------------------------------------------------- reverse DNS

const rdns = new Map<string, { name: string | null; at: number }>();
let rdnsWanted = 0;

function cachedName(ip: string): string | null {
  return rdns.get(ip)?.name ?? null;
}

async function resolveSome(ips: string[]) {
  const t = Date.now();
  const todo = ips.filter((ip) => {
    const c = rdns.get(ip);
    return !c || t - c.at > (c.name ? 3_600_000 : 600_000);
  });
  const batch = todo.slice(0, 30);
  let i = 0;
  const worker = async () => {
    while (i < batch.length) {
      const ip = batch[i++]!;
      rdns.set(ip, { name: rdns.get(ip)?.name ?? null, at: Date.now() }); // mark in-flight
      const name = await Promise.race([
        dns.promises.reverse(ip).then((n) => n[0] ?? null, () => null),
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      rdns.set(ip, { name, at: Date.now() });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  if (rdns.size > 5000) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, v] of rdns) if (v.at < cutoff) rdns.delete(k);
  }
}

// ---------------------------------------------------------------- sampling

interface Raw {
  t: number;
  list: Connection[];
  truncated: boolean;
}

async function sample(): Promise<Raw> {
  const [idx, nets, listening] = await Promise.all([containerIndex(), dockerNetworks(), hostListening()]);
  const gateways = new Set(nets.list.flatMap((n) => n.gateways));
  const out: Connection[] = [];

  // ---- host namespace
  let hostSockets: SsSocket[] = [];
  try {
    hostSockets = await hostEstablished();
  } catch {
    hostSockets = [];
  }
  for (const s of hostSockets) {
    const proc = s.processes[0] ?? null;
    // docker-proxy's leg into the container duplicates the container-side entry.
    if (proc && s.peer.port !== null && dockerProxyTarget(proc.pid)?.ip === stripMapped(s.peer.ip)) continue;
    const owner: Owner = proc ? ownerOfPid(proc.pid, idx) : { kind: "unknown" };
    const remoteIp = stripMapped(s.peer.ip);
    const inbound = (s.proto === "tcp" ? listening.tcp : listening.udp).has(s.local.port);
    out.push({
      proto: s.proto,
      local: { ip: stripMapped(s.local.ip), port: s.local.port },
      remote: { ip: remoteIp, port: s.peer.port ?? 0, host: null, scope: scopeOf(remoteIp, nets.block), container: idx.byIp.get(remoteIp)?.name ?? null },
      direction: inbound ? "in" : "out",
      process: proc,
      owner,
      ownerLabel: ownerLabel(owner, proc?.name),
      netns: "host",
      recvQ: s.recvQ,
      sendQ: s.sendQ,
    });
  }

  // ---- containers with their own network namespace
  const hostNs = netnsOf(1);
  const seenNs = new Set<string>();
  for (const m of idx.list) {
    if (m.hostNet || !m.pid) continue;
    const ns = netnsOf(m.pid);
    if (!ns || ns === hostNs || seenNs.has(ns)) continue;
    seenNs.add(ns);
    const socks = procNetSockets(readFile, m.pid);
    const listenTcp = new Set(socks.filter((x) => x.proto === "tcp" && x.st === "0A").map((x) => x.local.port));
    const owner: Owner = { kind: "container", id: m.id, name: m.name, appId: m.appId, appName: m.appName };
    for (const x of socks) {
      if (x.st !== "01") continue; // ESTABLISHED (TCP) / connected (UDP)
      const remoteIp = stripMapped(x.remote.ip);
      const inbound = x.proto === "tcp" && listenTcp.has(x.local.port);
      if (inbound && gateways.has(remoteIp)) continue; // arrived through docker-proxy: shown on the host side
      out.push({
        proto: x.proto,
        local: { ip: stripMapped(x.local.ip), port: x.local.port },
        remote: { ip: remoteIp, port: x.remote.port, host: null, scope: scopeOf(remoteIp, nets.block), container: idx.byIp.get(remoteIp)?.name ?? null },
        direction: inbound ? "in" : "out",
        process: null,
        owner,
        ownerLabel: ownerLabel(owner),
        netns: "container",
        recvQ: x.rxQ,
        sendQ: x.txQ,
      });
    }
  }

  const rank = { internet: 0, lan: 1, containers: 2, local: 3 } as const;
  out.sort((a, b) => rank[a.remote.scope] - rank[b.remote.scope] || a.ownerLabel.localeCompare(b.ownerLabel) || a.remote.ip.localeCompare(b.remote.ip));
  return { t: Date.now(), list: out.slice(0, MAX), truncated: out.length > MAX };
}

const poll = sharedPoll<Raw>("connections", 3000, async () => {
  const raw = await sample();
  if (rdnsWanted > 0) {
    const ips = [...new Set(raw.list.filter((c) => c.remote.scope === "internet" || c.remote.scope === "lan").map((c) => c.remote.ip))];
    void resolveSome(ips);
  }
  return raw;
});

/** Shape a raw sample for one client: hide loopback-only chatter, attach cached names, summarise. */
export function shape(raw: Raw, opts: { includeLocal: boolean; resolve: boolean }): ConnectionsSnapshot {
  let hiddenLocal = 0;
  const list: Connection[] = [];
  for (const c of raw.list) {
    if (!opts.includeLocal && c.remote.scope === "local" && isLoopback(c.local.ip)) {
      hiddenLocal++;
      continue;
    }
    list.push(opts.resolve ? { ...c, remote: { ...c.remote, host: cachedName(c.remote.ip) } } : c);
  }
  const counts = { total: list.length, inbound: 0, outbound: 0, internet: 0, lan: 0, containers: 0, hiddenLocal };
  const remotes = new Map<string, { ip: string; host: string | null; scope: Connection["remote"]["scope"]; count: number; owners: Set<string> }>();
  const owners = new Map<string, { label: string; inbound: number; outbound: number; total: number }>();
  for (const c of list) {
    if (c.direction === "in") counts.inbound++;
    else counts.outbound++;
    if (c.remote.scope === "internet") counts.internet++;
    else if (c.remote.scope === "lan") counts.lan++;
    else if (c.remote.scope === "containers") counts.containers++;
    // Top talkers: devices and hosts outside this server (container-to-container pools drown them out otherwise).
    if (c.remote.scope === "internet" || c.remote.scope === "lan") {
      const r = remotes.get(c.remote.ip) ?? { ip: c.remote.ip, host: c.remote.host ?? c.remote.container, scope: c.remote.scope, count: 0, owners: new Set<string>() };
      r.count++;
      r.owners.add(c.ownerLabel);
      remotes.set(c.remote.ip, r);
    }
    const o = owners.get(c.ownerLabel) ?? { label: c.ownerLabel, inbound: 0, outbound: 0, total: 0 };
    o.total++;
    if (c.direction === "in") o.inbound++;
    else o.outbound++;
    owners.set(c.ownerLabel, o);
  }
  return {
    t: raw.t,
    connections: list,
    counts,
    topRemotes: [...remotes.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((r) => ({ ...r, owners: [...r.owners].slice(0, 5) })),
    topOwners: [...owners.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    truncated: raw.truncated,
  };
}

export function subscribeConnections(opts: { includeLocal: boolean; resolve: boolean }, onData: (s: ConnectionsSnapshot) => void, onError: (e: Error) => void): () => void {
  if (opts.resolve) rdnsWanted++;
  const off = poll.subscribe((raw) => onData(shape(raw, opts)), onError);
  return () => {
    off();
    if (opts.resolve) rdnsWanted = Math.max(0, rdnsWanted - 1);
  };
}
