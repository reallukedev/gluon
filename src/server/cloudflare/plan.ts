import { edgeCovered, type DnsRecordT, type DnsType } from "@/lib/cloudflare-types";

/**
 * What DNS should say for the public addresses, and what to change in Cloudflare to get there.
 * Pure: no network, no store. sync.ts feeds it the routes, the zone's records and the addresses.
 *
 * Every record is an A (and optionally AAAA) record at this network's address. With the proxy on,
 * web names go through Cloudflare (orange cloud): the base domain, the wildcard that covers every
 * name one level under it, and any deeper name Cloudflare's free certificate still covers. Chat
 * and voice can't be proxied, and addresses marked "direct" opt out, so they get records of their
 * own that point straight here.
 */

/** Written on every record Gluon makes, so it can tell its own records from anyone else's. */
export const MARK = "Managed by Gluon";

export interface PlanRoute {
  host: string;
  name: string;
  enabled: boolean;
  /** Web traffic (a site, an app, a redirect) as opposed to chat or voice, which can't be proxied. */
  web: boolean;
  /** Skips Cloudflare's proxy: its own record straight at this network. */
  direct: boolean;
}

export interface PlanInput {
  zone: string;
  baseDomain: string;
  routes: PlanRoute[];
  ipv4: string | null;
  ipv6: string | null;
  /** Web addresses go through Cloudflare's proxy. */
  proxy: boolean;
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

/** Through Cloudflare's proxy, as far as Gluon decides it. */
export function proxiedName(input: Pick<PlanInput, "zone" | "proxy">, host: string, web = true, direct = false): boolean {
  return input.proxy && web && !direct && edgeCovered(host, norm(input.zone));
}

export function wanted(input: PlanInput): { wants: Want[]; held: string[]; problems: string[]; covered: { name: string; why: string }[] } {
  const zone = norm(input.zone);
  const base = norm(input.baseDomain);
  const out = new Map<string, Want>();
  // Names Gluon would write but can't (no address to point at): their records stay as they are.
  const held = new Set<string>();
  // Names left to the wildcard, which plan() still checks for records of their own.
  const covered: { name: string; why: string }[] = [];

  const add = (name: string, why: string, proxied: boolean) => {
    if (!inZone(name, zone) || out.has(name)) return;
    if (!input.ipv4) {
      held.add(name);
      return;
    }
    out.set(name, {
      name,
      why,
      records: [{ type: "A", content: input.ipv4, proxied }, ...(input.ipv6 ? [{ type: "AAAA" as const, content: input.ipv6, proxied }] : [])],
    });
  };

  const wildcardProxied = proxiedName(input, `x.${base}`);
  if (inZone(base, zone)) {
    // The base domain has always gone through Cloudflare, when the certificate allows it.
    add(base, "Base domain", edgeCovered(base, zone));
    add(`*.${base}`, `Every name under ${base}`, wildcardProxied);
  }
  for (const r of input.routes) {
    const host = norm(r.host);
    if (!r.enabled || !inZone(host, zone) || host === base) continue;
    const proxied = proxiedName(input, host, r.web, r.direct);
    // The wildcard already says the same thing for this name.
    if (underWildcard(host, base) && proxied === wildcardProxied) {
      if (!covered.some((c) => c.name === host)) covered.push({ name: host, why: r.name });
      continue;
    }
    add(host, r.name, proxied);
  }
  const problems = held.size ? ["Couldn't find this network's internet address, so its records were left as they are."] : [];
  return { wants: [...out.values()], held: [...held], problems, covered: held.size ? [] : covered };
}

const same = (a: Pick<DnsRecordT, "content" | "proxied"> & { type: string }, b: DnsRecordT) => a.type === b.type && a.proxied === b.proxied && norm(a.content) === norm(b.content);
const strip = (r: ExistingRecord): DnsRecordT => ({ type: r.type as DnsType, content: r.content, proxied: r.proxied });

/**
 * Compare what Gluon wants with the zone's records.
 *
 * `adopted` names are ones the person handed to Gluon: their records count as Gluon's own. Any
 * other record Gluon didn't make blocks its name ("conflict") and nothing there is touched.
 * Gluon's own records at names it no longer wants are removed, but never at a name it only
 * skipped for want of an address.
 */
export function plan(input: PlanInput, existing: ExistingRecord[], adopted: Iterable<string> = []): Plan {
  const { wants, held, problems, covered } = wanted(input);
  const taken = new Set([...adopted].map(norm));
  const byName = new Map<string, ExistingRecord[]>();
  for (const r of existing) {
    if (!TYPES.has(r.type as DnsType)) continue;
    const n = norm(r.name);
    byName.set(n, [...(byName.get(n) ?? []), r]);
  }
  for (const n of held) byName.delete(n);
  const mine = (r: ExistingRecord) => r.comment === MARK || taken.has(norm(r.name));
  // A name's own records beat the wildcard. Gluon's own there are only leftovers (removed below),
  // but anyone else's would quietly send that address somewhere else, so it's planned like any name.
  const wildcard = wants.find((w) => w.name === `*.${norm(input.baseDomain)}`);
  for (const c of covered) {
    if (wildcard && !wants.some((w) => w.name === c.name) && (byName.get(c.name) ?? []).some((r) => r.comment !== MARK)) wants.push({ name: c.name, why: c.why, records: wildcard.records });
  }
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

  // Without an address nothing is rewritten, so nothing Gluon made is taken away either.
  if (!held.length) {
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
  }

  const all = names.flatMap((n) => n.actions);
  const order = { delete: 0, update: 1, create: 2 } as const;
  const actions = all.map((a, i) => [a, i] as const).sort((x, y) => order[x[0].op] - order[y[0].op] || x[1] - y[1]).map(([a]) => a);
  return { names, actions, problems };
}
