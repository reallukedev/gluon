import type { LineState } from "@/lib/types";
import type { HostDns, McPing, McTarget } from "@/lib/games-types";
import type { DnsResult } from "@/lib/network-types";

/** What one Minecraft address does right now, in a line. Pure. */

const players = (p: McPing) => (p.online === null ? null : p.online === 0 ? "nobody playing" : `${p.online}${p.max ? ` of ${p.max}` : ""} playing`);

export function routeVerdict(ping: McPing | null, target: McTarget, router: "missing" | "stopped" | "running", backend: string): { state: LineState; summary: string } {
  if (router !== "running") return { state: "unknown", summary: "Not checked" };
  if (!ping) return { state: "unknown", summary: "Not checked yet" };
  if (ping.ok) return { state: "running", summary: ["Answers", ping.version, players(ping)].filter(Boolean).join(" · ") };
  // Short: the server column already names the server.
  if (target.kind === "crafty") {
    const on = target.servers;
    if (!on.length) return { state: "unhealthy", summary: "No Crafty server uses this port" };
    const running = on.filter((s) => s.running);
    if (on.every((s) => s.running === false)) return { state: "stopped", summary: on.length === 1 ? "Stopped in Crafty" : on.length === 2 ? "Both stopped in Crafty" : `All ${on.length} stopped in Crafty` };
    if (running.length) return { state: "unhealthy", summary: "Running in Crafty, not answering yet" };
    return { state: "stopped", summary: "Not answering, probably stopped" };
  }
  if (target.kind === "container") {
    if (!target.running) return { state: "stopped", summary: "Container stopped" };
    if (!target.sharesNetwork) return { state: "unhealthy", summary: "Not on mc-router's Docker network" };
    return { state: "unhealthy", summary: `Not answering on port ${backend.slice(backend.lastIndexOf(":") + 1)}` };
  }
  return { state: "unhealthy", summary: "Not answering" };
}

/** Does `host` lead players here? Minecraft can't go through Cloudflare's proxy, which only carries web traffic. */
export function hostDns(host: string, r: DnsResult | null, publicKnown: boolean): HostDns {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { status: "literal", message: "An IP address, so there's nothing to look up.", addresses: [host] };
  if (!r) return { status: "error", message: `Gluon couldn't look up ${host}.`, addresses: [] };
  const addresses = [...r.a, ...r.aaaa];
  if (r.status === "missing") return { status: "missing", message: `${host} has no DNS record, so players outside your home can't find it.`, addresses };
  if (r.status === "error") return { status: "error", message: r.message, addresses };
  if (r.proxied) return { status: "proxied", message: `${host} goes through Cloudflare's proxy, which only carries websites. Set it to DNS only in Cloudflare.`, addresses };
  if (r.status === "mismatch") return { status: "elsewhere", message: `${r.message} Players outside your home won't reach this server.`, addresses };
  if (!publicKnown || r.matchesPublicIp === null) return { status: "error", message: `${host} points at ${addresses.join(", ")}. Gluon couldn't find your home's public address to compare.`, addresses };
  return { status: "home", message: `${host} points at your home.`, addresses };
}
