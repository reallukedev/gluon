import type { DnsRecordT, DnsType } from "@/lib/cloudflare-types";

/**
 * What DNS should say for the public addresses, and what to change in Cloudflare to get there.
 * Pure: no network, no store. sync.ts feeds it the routes, the zone's records and the addresses.
 *
 * The shape follows how Gluon publishes: the base domain is proxied by Cloudflare, every name one
 * level under it is covered by a wildcard, and names deeper or elsewhere in the zone get their own
 * record. With a tunnel, web names become CNAMEs to the tunnel; chat, voice and addresses marked
 * "direct" keep A records pointing at this network, since only web traffic can ride the tunnel.
 */

/** Written on every record Gluon makes, so it can tell its own records from anyone else's. */
export const MARK = "Managed by Gluon";

export interface PlanRoute {
  host: string;
  name: string;
  enabled: boolean;
  /** Web traffic (a site, an app, a redirect) as opposed to chat or voice, which can't be proxied. */
  web: boolean;
  /** Skips the tunnel: its own A record straight at this network. */
  direct: boolean;
}

export interface PlanInput {
  zone: string;
  baseDomain: string;
  routes: PlanRoute[];
  ipv4: string | null;
  ipv6: string | null;
  /** The tunnel's CNAME target (<id>.cfargotunnel.com) when the tunnel is on. */
  tunnelHost: string | null;
}

/** A record as Cloudflare lists it; any type, though Gluon only ever looks at A, AAAA and CNAME. */
export interface ExistingRecord extends Omit<DnsRecordT, "type"> {
  type: string;
  id: string;
  name: string;
  comment: string | null;
}

export interface Want {
  name: string;
  why: string;
  records: DnsRecordT[];
}

export type Action =
  | { op: "create"; name: string; record: DnsRecordT }
  | { op: "update"; name: string; id: string; record: DnsRecordT }
  | { op: "delete"; name: string; id: string; record: DnsRecordT };

export interface NamePlan {
  name: string;
  why: string;
  want: DnsRecordT[];
  have: DnsRecordT[];
  state: "ok" | "change" | "conflict";
  actions: Action[];
}

export interface Plan {
  names: NamePlan[];
  /** Deletes first (a CNAME can't share a name with anything), then updates, then creates. */
  actions: Action[];
  problems: string[];
}

const TYPES = new Set<DnsType>(["A", "AAAA", "CNAME"]);
const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

export const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

/** One label under the base domain, so the wildcard covers it. */
export const underWildcard = (host: string, base: string) => host.endsWith(`.${base}`) && !host.slice(0, -base.length - 1).includes(".");

export function wanted(input: PlanInput): { wants: Want[]; problems: string[] } {
  const zone = norm(input.zone);
  const base = norm(input.baseDomain);
  const problems: string[] = [];
  const out = new Map<string, Want>();
  const tunnel = input.tunnelHost;
  let missingIp = false;

  const address = (proxied: boolean): DnsRecordT[] => {
    if (!input.ipv4) {
      missingIp = true;
      return [];
    }
    return [{ type: "A", content: input.ipv4, proxied }, ...(input.ipv6 ? [{ type: "AAAA" as const, content: input.ipv6, proxied }] : [])];
  };
  const viaTunnel = (): DnsRecordT[] => [{ type: "CNAME", content: tunnel!, proxied: true }];
  const add = (name: string, why: string, records: DnsRecordT[]) => {
    if (!inZone(name, zone) || out.has(name)) return;
    // No address to point at: leave whatever is there rather than deleting it.
    if (!records.length) return;
    out.set(name, { name, why, records });
  };

  if (inZone(base, zone)) {
    add(base, "Base domain", tunnel ? viaTunnel() : address(true));
    add(`*.${base}`, `Every name under ${base}`, tunnel ? viaTunnel() : address(false));
  }
  for (const r of input.routes) {
    const host = norm(r.host);
    if (!r.enabled || !inZone(host, zone) || host === base) continue;
    const covered = underWildcard(host, base);
    const goesDirect = !r.web || (tunnel !== null && r.direct);
    if (goesDirect) {
      // Through the wildcard already, unless the wildcard now leads to the tunnel.
      if (covered && !tunnel) continue;
      add(host, r.name, address(false));
    } else if (!covered) {
      add(host, r.name, tunnel ? viaTunnel() : address(false));
    }
  }
  if (missingIp) problems.push("Couldn't find this network's internet address, so its A records were left as they are.");
  return { wants: [...out.values()], problems };
}

const same = (a: Pick<DnsRecordT, "content" | "proxied"> & { type: string }, b: DnsRecordT) => a.type === b.type && a.proxied === b.proxied && norm(a.content) === norm(b.content);
const strip = (r: ExistingRecord): DnsRecordT => ({ type: r.type as DnsType, content: r.content, proxied: r.proxied });

/**
 * Compare what Gluon wants with the zone's records.
 *
 * `adopted` names are ones the person handed to Gluon: their records count as Gluon's own. Any
 * other record Gluon didn't make blocks its name ("conflict") and nothing there is touched.
 * Gluon's own records at names it no longer wants are removed.
 */
export function plan(input: PlanInput, existing: ExistingRecord[], adopted: Iterable<string> = []): Plan {
  const { wants, problems } = wanted(input);
  const taken = new Set([...adopted].map(norm));
  const byName = new Map<string, ExistingRecord[]>();
  for (const r of existing) {
    if (!TYPES.has(r.type as DnsType)) continue;
    const n = norm(r.name);
    byName.set(n, [...(byName.get(n) ?? []), r]);
  }
  const mine = (r: ExistingRecord) => r.comment === MARK || taken.has(norm(r.name));
  const names: NamePlan[] = [];

  for (const w of wants) {
    const have = byName.get(w.name) ?? [];
    byName.delete(w.name);
    const foreign = have.filter((r) => !mine(r));
    const exact = have.length === w.records.length && w.records.every((d) => have.some((h) => same(h, d)));
    if (exact) {
      names.push({ name: w.name, why: w.why, want: w.records, have: have.map(strip), state: "ok", actions: [] });
      continue;
    }
    if (foreign.length) {
      names.push({ name: w.name, why: w.why, want: w.records, have: have.map(strip), state: "conflict", actions: [] });
      continue;
    }
    const actions: Action[] = [];
    const left = [...have];
    const todo: DnsRecordT[] = [];
    // Keep records that already match; reuse a record of the same type for an update.
    for (const d of w.records) {
      const i = left.findIndex((h) => same(h, d));
      if (i >= 0) left.splice(i, 1);
      else todo.push(d);
    }
    for (const d of todo) {
      const i = left.findIndex((h) => h.type === d.type);
      if (i >= 0) {
        actions.push({ op: "update", name: w.name, id: left[i]!.id, record: d });
        left.splice(i, 1);
      } else actions.push({ op: "create", name: w.name, record: d });
    }
    for (const h of left) actions.push({ op: "delete", name: w.name, id: h.id, record: strip(h) });
    names.push({ name: w.name, why: w.why, want: w.records, have: have.map(strip), state: "change", actions });
  }

  // Names Gluon made records for but no longer wants.
  for (const [name, have] of byName) {
    const own = have.filter((r) => r.comment === MARK);
    if (!own.length) continue;
    names.push({
      name,
      why: "No longer published",
      want: [],
      have: have.map(strip),
      state: "change",
      actions: own.map((h) => ({ op: "delete", name, id: h.id, record: strip(h) })),
    });
  }

  const all = names.flatMap((n) => n.actions);
  const order = { delete: 0, update: 1, create: 2 } as const;
  const actions = all.map((a, i) => [a, i] as const).sort((x, y) => order[x[0].op] - order[y[0].op] || x[1] - y[1]).map(([a]) => a);
  return { names, actions, problems };
}

export interface IngressRule {
  hostname?: string;
  service: string;
}

/**
 * The tunnel's routing table: every web name it carries goes to Caddy on this machine, which sends
 * it on to the right app. Explicit names first (cloudflared takes the first match), then the base
 * domain and its wildcard, then a 404 for anything else.
 */
export function ingress(input: Pick<PlanInput, "zone" | "baseDomain" | "routes">, origin = "http://localhost:80"): IngressRule[] {
  const zone = norm(input.zone);
  const base = norm(input.baseDomain);
  const seen = new Set<string>();
  const rules: IngressRule[] = [];
  const add = (hostname: string) => {
    if (seen.has(hostname) || !inZone(hostname, zone)) return;
    seen.add(hostname);
    rules.push({ hostname, service: origin });
  };
  for (const r of input.routes) {
    const host = norm(r.host);
    if (r.enabled && r.web && !r.direct && host !== base && !underWildcard(host, base)) add(host);
  }
  add(base);
  add(`*.${base}`);
  rules.push({ service: "http_status:404" });
  return rules;
}
