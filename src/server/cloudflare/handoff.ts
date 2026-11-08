import type { CloudflareStatus, CloudflareZoneT, DdnsHandoff, DnsRecordT, HandoffReason } from "@/lib/cloudflare-types";
import type { DdnsStatus } from "@/lib/network-types";
import { inZone } from "./plan";

/**
 * Moving from cloudflare-ddns to Gluon, name by name. Pure: the updater's status and Gluon's last
 * sync in, a verdict out. "Safe" means stopping the updater would change nothing in DNS, so it's
 * only said when every one of its names is Gluon's to keep and already holds what Gluon would write.
 */

const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

export function ddnsNamesOf(d: Pick<DdnsStatus, "config">): string[] {
  return [...new Set([...d.config.domains, ...d.config.ip4Domains, ...d.config.ip6Domains].map(norm))].filter(Boolean);
}

const sameRecords = (a: DnsRecordT[], b: DnsRecordT[]) => a.length === b.length && a.every((x) => b.some((y) => y.type === x.type && y.proxied === x.proxied && norm(y.content) === norm(x.content)));

export function handoff(d: DdnsStatus, zones: CloudflareZoneT[], sync: CloudflareStatus["sync"]): DdnsHandoff {
  const proxied = new Set(d.config.proxiedDomains.map(norm));
  const covered = new Set(sync.covered);
  const readOnly = new Set(sync.readOnly);
  const names = ddnsNamesOf(d).map((name) => {
    const bare = name.replace(/^\*\./, "");
    const zone = zones.filter((z) => inZone(bare, z.name)).sort((a, b) => b.name.length - a.name.length)[0];
    const m = sync.names.find((x) => x.name === name && x.want.length > 0);
    let reason: HandoffReason | null = null;
    if (!zone) reason = "outside";
    else if (readOnly.has(zone.name)) reason = "read-only";
    else if (m) reason = m.state === "error" ? "error" : m.foreign ? "foreign" : sameRecords(m.want, m.have) ? null : "differs";
    else if (!covered.has(name)) reason = "not-kept";
    return { name, proxied: proxied.has(name), reason, have: m?.have ?? [], want: m?.want ?? [] };
  });
  const blocked = sync.at === null ? "Gluon hasn't checked DNS yet." : (sync.problems[0] ?? null);
  const deleteOnStop = d.container.running && d.config.deleteOnStop;
  return {
    container: d.container.name,
    running: d.container.running,
    project: d.container.project,
    names,
    deleteOnStop,
    blocked,
    ipv6Differs: names.some((n) => n.reason === "differs" && n.have.some((r) => r.type === "AAAA") && !n.want.some((r) => r.type === "AAAA")),
    canTakeOver: names.some((n) => n.reason === "not-kept" || n.reason === "foreign"),
    safe: !blocked && !deleteOnStop && names.every((n) => n.reason === null),
  };
}
