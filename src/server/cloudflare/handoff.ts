import type { CloudflareStatus, CloudflareZoneT, DdnsHandoff, HandoffReason } from "@/lib/cloudflare-types";
import type { DdnsStatus } from "@/lib/network-types";
import { inZone } from "./plan";

/**
 * Moving from cloudflare-ddns to Gluon, name by name. Pure: the updater's status and Gluon's last
 * sync in, a verdict out. "Safe" means stopping the updater would change nothing a visitor or
 * player could notice, so it's only said when every one of its names is already Gluon's to keep.
 */

const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

export function ddnsNamesOf(d: Pick<DdnsStatus, "config">): string[] {
  return [...new Set([...d.config.domains, ...d.config.ip4Domains, ...d.config.ip6Domains].map(norm))].filter(Boolean);
}

export function handoff(d: DdnsStatus, zones: CloudflareZoneT[], sync: CloudflareStatus["sync"], gluonIpv6: boolean): DdnsHandoff {
  const proxied = new Set(d.config.proxiedDomains.map(norm));
  const covered = new Set(sync.covered);
  const names = ddnsNamesOf(d).map((name) => {
    const bare = name.replace(/^\*\./, "");
    let reason: HandoffReason | null = null;
    const m = sync.names.find((x) => x.name === name && x.want.length > 0);
    if (!zones.some((z) => inZone(bare, z.name))) reason = "outside";
    else if (m) reason = m.state === "error" ? "error" : m.foreign ? "foreign" : null;
    else if (!covered.has(name)) reason = "not-kept";
    return { name, proxied: proxied.has(name), reason };
  });
  const blocked = sync.at === null ? "Gluon hasn't checked DNS yet." : (sync.problems[0] ?? null);
  const deleteOnStop = d.container.running && d.config.deleteOnStop;
  const publishesV6 = d.config.ip6Provider !== "none" && (d.ipv6?.addresses.length ?? 0) > 0 && names.some((n) => !d.config.ip4Domains.map(norm).includes(n.name));
  return {
    container: d.container.name,
    running: d.container.running,
    project: d.container.project,
    names,
    deleteOnStop,
    blocked,
    ipv6Differs: publishesV6 && !gluonIpv6,
    canTakeOver: names.some((n) => n.reason === "not-kept" || n.reason === "foreign"),
    safe: !blocked && !deleteOnStop && names.every((n) => n.reason === null),
  };
}
