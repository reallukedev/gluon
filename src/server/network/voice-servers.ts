import "server-only";
import { docker } from "../docker/client";
import type { AppSummary } from "../docker/apps";
import { MUMBLE_PORT } from "../caddy/routes";
import type { VoiceServerCandidate } from "@/lib/network-types";

/** mumblevoip/mumble-server, the older murmur images, and the like. */
export const MUMBLE_IMAGE = /(^|\/)(mumble-server|mumblevoip\/mumble-server|murmur)[^/]*(:|$)|murmur/i;

/** Containers on this server that look like a Mumble voice server, for the Network editor. */
export async function voiceServerCandidates(): Promise<VoiceServerCandidate[]> {
  const list = await docker().listContainers({ all: true });
  return list
    .filter((c) => MUMBLE_IMAGE.test(c.Image))
    .map((c) => {
      const host = c.HostConfig?.NetworkMode === "host";
      const tcp = c.Ports.find((p) => p.PrivatePort === MUMBLE_PORT && p.Type === "tcp" && p.PublicPort)?.PublicPort ?? null;
      const udp = host || c.Ports.some((p) => p.PrivatePort === MUMBLE_PORT && p.Type === "udp" && p.PublicPort);
      return {
        container: (c.Names[0] ?? c.Id).replace(/^\//, ""),
        image: c.Image,
        project: c.Labels?.["com.docker.compose.project"] ?? null,
        running: c.State === "running",
        port: host ? MUMBLE_PORT : tcp,
        udp,
        ports: [...new Set(c.Ports.filter((p) => p.PublicPort).map((p) => p.PublicPort!))].sort((a, b) => a - b),
      };
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || a.container.localeCompare(b.container));
}

/**
 * Host ports where Mumble answers, each with the host port its UDP side is published on. Mumble
 * bans an address after 10 connections in 2 minutes (successful ones count), so Gluon never sends
 * HTTP or TLS to these and only pings them over UDP, which doesn't count.
 */
export function mumblePorts(apps: AppSummary[]): Map<number, number> {
  const out = new Map<number, number>([[MUMBLE_PORT, MUMBLE_PORT]]);
  for (const a of apps)
    for (const c of a.containers) {
      if (!MUMBLE_IMAGE.test(c.image)) continue;
      for (const p of c.ports) {
        if (p.proto !== "tcp" || !p.host) continue;
        const udp = c.ports.find((u) => u.proto === "udp" && u.container === p.container)?.host;
        out.set(p.host, udp ?? p.host);
      }
    }
  return out;
}
