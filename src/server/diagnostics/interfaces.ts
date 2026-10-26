import "server-only";
import { host } from "../host/exec";
import { readHostFileOr } from "../host/paths";
import { netDev, isPhysicalIface } from "../host/proc";
import { dockerNetworks } from "./attribution";
import type { InterfaceInfo } from "@/lib/diagnostics-types";

/** Host network interfaces: `ip -j addr` (addresses, state, MTU) + /proc/1/net/dev counters + sysfs speed. */

interface IpAddrJson {
  ifname: string;
  flags?: string[];
  mtu?: number;
  operstate?: string;
  link_type?: string;
  address?: string;
  addr_info?: { family: string; local: string; prefixlen: number; scope: string }[];
}

let cache: { at: number; value: IpAddrJson[] } | null = null;

export async function ipAddr(maxAgeMs = 10_000): Promise<IpAddrJson[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  try {
    const { stdout } = await host("ip", ["-j", "addr"], { timeoutMs: 5000 });
    const value = JSON.parse(stdout) as IpAddrJson[];
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? [];
  }
}

/** address → interface name, for every address on the host. */
export async function addressOwners(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of await ipAddr()) for (const a of l.addr_info ?? []) out.set(a.local.toLowerCase(), l.ifname);
  return out;
}

function kindOf(name: string, linkType?: string): InterfaceInfo["kind"] {
  if (name === "lo" || linkType === "loopback") return "loopback";
  if (/^(docker\d*|br-|virbr|cni|flannel)/.test(name)) return "bridge";
  if (/^veth/.test(name)) return "veth";
  if (/^(wl|wlan)/.test(name)) return "wireless";
  if (/^(tun|tap|wg|tailscale|zt|ppp)/.test(name)) return "vpn";
  if (/^(en|eth|eno|ens|enp)/.test(name)) return "ethernet";
  return "other";
}

export async function interfaces(): Promise<InterfaceInfo[]> {
  const [links, nets] = await Promise.all([ipAddr(), dockerNetworks().catch(() => ({ list: [] as { name: string; bridge: string | null }[] }))]);
  const counters = new Map(netDev(1).map((n) => [n.iface, n]));
  const bridgeNames = new Map(nets.list.filter((n) => n.bridge).map((n) => [n.bridge!, n.name]));
  const out: InterfaceInfo[] = links.map((l) => {
    const c = counters.get(l.ifname);
    const speed = Number(readHostFileOr(`/sys/class/net/${l.ifname}/speed`, "").trim());
    return {
      name: l.ifname,
      kind: kindOf(l.ifname, l.link_type),
      dockerNetwork: bridgeNames.get(l.ifname) ?? (l.ifname === "docker0" ? "bridge" : null),
      state: l.operstate ?? "UNKNOWN",
      mtu: l.mtu ?? null,
      mac: l.link_type === "ether" ? (l.address ?? null) : null,
      speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
      addresses: (l.addr_info ?? []).map((a) => ({ family: a.family === "inet6" ? "inet6" : "inet", address: a.local, prefix: a.prefixlen, scope: a.scope })),
      rxTotal: c?.rx ?? 0,
      txTotal: c?.tx ?? 0,
      rxErrors: c?.rxErrors ?? 0,
      txErrors: c?.txErrors ?? 0,
      physical: isPhysicalIface(l.ifname),
    };
  });
  const order: InterfaceInfo["kind"][] = ["ethernet", "wireless", "vpn", "other", "bridge", "loopback", "veth"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}
