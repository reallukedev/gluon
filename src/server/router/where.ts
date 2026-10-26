import "server-only";
import os from "node:os";
import { defaultGateways } from "../diagnostics/checkup/probes";
import { ipAddr } from "../diagnostics/interfaces";
import { local } from "../host/exec";

export interface Here {
  gateway: string | null;
  lanIp: string | null;
  mac: string | null;
  hostname: string;
}

/** The interface whose IPv4 network holds `gw` (a /24 match is enough for a home network). */
function nicFor(gw: string): { ip: string; mac: string } | null {
  const prefix = gw.split(".").slice(0, 3).join(".") + ".";
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && a.address.startsWith(prefix)) return { ip: a.address, mac: a.mac.toLowerCase() };
    }
  }
  return null;
}

let cached: { at: number; value: Here } | null = null;

/**
 * This server on the home network: the router's address, its own address, MAC and name. On the
 * server that's the host's default route. GLUON_ROUTER_GATEWAY overrides the router's address
 * (for development), and on a Mac, where there's no `ip`, `route` answers instead.
 */
export async function whereAmI(): Promise<Here> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const hostname = os.hostname();
  let value: Here;
  const override = process.env.GLUON_ROUTER_GATEWAY?.trim();
  if (override) {
    const nic = nicFor(override);
    value = { gateway: override, lanIp: nic?.ip ?? null, mac: nic?.mac ?? null, hostname };
  } else {
    const gw = (await defaultGateways().catch(() => [])).find((x) => x.family === 4) ?? null;
    if (gw) {
      const link = gw.dev ? (await ipAddr().catch(() => [])).find((l) => l.ifname === gw.dev) : undefined;
      value = { gateway: gw.gateway, lanIp: link?.addr_info?.find((a) => a.family === "inet")?.local ?? null, mac: link?.address?.toLowerCase() ?? null, hostname };
    } else if (process.platform === "darwin") {
      const out = await local("route", ["-n", "get", "default"], { timeoutMs: 3000 }).catch(() => null);
      const gateway = out?.stdout.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
      const ifname = out?.stdout.match(/interface:\s*(\w+)/)?.[1];
      const nic = gateway ? nicFor(gateway) : null;
      // Node can report a placeholder MAC on macOS; ifconfig has the real one.
      const ether = ifname ? (await local("ifconfig", [ifname], { timeoutMs: 3000 }).catch(() => null))?.stdout.match(/ether\s+([0-9a-f:]{17})/i)?.[1] : undefined;
      value = { gateway, lanIp: nic?.ip ?? null, mac: ether?.toLowerCase() ?? nic?.mac ?? null, hostname };
    } else value = { gateway: null, lanIp: null, mac: null, hostname };
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Names the router might list this server under. */
export const serverNames = (h: Here) => [h.hostname, h.hostname.split(".")[0] ?? "", h.lanIp ?? "", h.mac ?? ""].filter(Boolean);
