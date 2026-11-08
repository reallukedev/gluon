import { edgeCovered, type DnsRecordT, type DnsType } from "@/lib/cloudflare-types";

/**
 * What DNS should say for the public addresses, and what to change in Cloudflare to get there.
 * Pure: no network, no store. sync.ts feeds it the routes, the zone's records and the addresses.
 *
 * Every record is an A (and optionally AAAA) record at this network's address. With the proxy on,
 * web names go through Cloudflare (orange cloud): the base domain, the wildcard that covers every
 * name one level under it, and any deeper name Cloudflare's free certificate still covers. Chat
 * and voice can't be proxied, and addresses marked "direct" opt out, so they get records of their
 * own that point straight here. Game addresses (Minecraft through mc-router, forwarded game ports)
 * always point straight here, and so do the extra names the admin asks Gluon to keep, unless one
 * of those is marked as proxied.
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

/** A game address: never proxied, since Cloudflare's proxy only carries web traffic. */
export interface PlanGame {
  host: string;
  why: string;
}

/** A name the admin asked Gluon to keep pointed here, wildcards included. */
export interface PlanKept {
  name: string;
  proxied: boolean;
}

export interface PlanInput {
  zone: string;
  baseDomain: string;
  routes: PlanRoute[];
  ipv4: string | null;
  ipv6: string | null;
  /** Web addresses go through Cloudflare's proxy. */
  proxy: boolean;
  games?: PlanGame[];
  kept?: PlanKept[];
  /**
   * Names another updater (cloudflare-ddns) is still writing. Gluon plans them but changes nothing
   * there until it stops, so the two never take turns rewriting the same record.
   */
  defer?: string[];
  /** Something Gluon keeps couldn't be read this time (the game addresses), so nothing is removed. */
  partial?: boolean;
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
  /** deferred: another updater is still writing this name; Gluon takes over when it stops. */
  state: "ok" | "change" | "conflict" | "deferred";
  /** Has A, AAAA or CNAME records Gluon didn't make and wasn't handed. */
  foreign: boolean;
  actions: Action[];
}

export interface Plan {
  names: NamePlan[];
  /** Deletes first (a CNAME can't share a name with anything), then updates, then creates. */
  actions: Action[];
  problems: string[];
  /** Names a wildcard Gluon keeps answers for, with no record of their own needed. */
  covered: string[];
}

const TYPES = new Set<DnsType>(["A", "AAAA", "CNAME"]);
const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

export const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

/** One label under the base domain, so the wildcard covers it. */
export const underWildcard = (host: string, base: string) => host.endsWith(`.${base}`) && !host.slice(0, -base.length - 1).includes(".");

/** The wildcard name that would answer for `host` (`*.mc.example.com` for `a.mc.example.com`). */
const wildcardOf = (host: string) => (host.includes(".") ? `*.${host.slice(host.indexOf(".") + 1)}` : null);

/** Through Cloudflare's proxy, as far as Gluon decides it. */
export function proxiedName(input: Pick<PlanInput, "zone" | "proxy">, host: string, web = true, direct = false): boolean {
  return input.proxy && web && !direct && edgeCovered(host, norm(input.zone));
}

export function wanted(input: PlanInput): { wants: Want[]; held: string[]; problems: string[]; covered: { name: string; why: string; wildcard: string }[] } {
  const zone = norm(input.zone);
  const base = norm(input.baseDomain);
  const out = new Map<string, Want>();
  // Names Gluon would write but can't (no address to point at): their records stay as they are.
  const held = new Set<string>();
  // Names left to a wildcard, which plan() still checks for records of their own.
  const covered: { name: string; why: string; wildcard: string }[] = [];
  // Wildcards Gluon keeps here, and whether each is proxied (known even without an address).
  const wilds = new Map<string, boolean>();

  const add = (name: string, why: string, proxied: boolean) => {
    if (!inZone(name.replace(/^\*\./, ""), zone) || out.has(name) || held.has(name)) return;
    if (name.startsWith("*.")) wilds.set(name, proxied);
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
  /** Added, unless a wildcard Gluon keeps already says the same thing for it. */
  const addCoverable = (host: string, why: string, proxied: boolean) => {
    const w = wildcardOf(host);
    if (w && !out.has(host) && wilds.get(w) === proxied) {
      if (!covered.some((c) => c.name === host)) covered.push({ name: host, why, wildcard: w });
      return;
    }
    add(host, why, proxied);
  };

  if (inZone(base, zone)) {
    // The base domain has always gone through Cloudflare, when the certificate allows it.
    add(base, "Base domain", edgeCovered(base, zone));
    add(`*.${base}`, `Every name under ${base}`, proxiedName(input, `x.${base}`));
  }
  const kept = (input.kept ?? []).map((k) => ({ name: norm(k.name), proxied: k.proxied && edgeCovered(norm(k.name).replace(/^\*\./, "x."), zone) }));
  // Kept wildcards first, so the addresses under them can lean on them.
  for (const k of kept) if (k.name.startsWith("*.")) add(k.name, "Other name", k.proxied);
  for (const r of input.routes) {
    const host = norm(r.host);
    if (!r.enabled || !inZone(host, zone) || host === base) continue;
    addCoverable(host, r.name, proxiedName(input, host, r.web, r.direct));
  }
  for (const gm of input.games ?? []) {
    const host = norm(gm.host);
    if (inZone(host, zone) && host !== base) addCoverable(host, gm.why, false);
  }
  for (const k of kept) if (!k.name.startsWith("*.")) add(k.name, "Other name", k.proxied);
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
  const deferred = new Set((input.defer ?? []).map(norm));
  const byName = new Map<string, ExistingRecord[]>();
  for (const r of existing) {
    if (!TYPES.has(r.type as DnsType)) continue;
    const n = norm(r.name);
    byName.set(n, [...(byName.get(n) ?? []), r]);
  }
  for (const n of held) byName.delete(n);
  // Another updater's names: never cleaned up from here either.
  for (const n of deferred) if (!wants.some((w) => w.name === n)) byName.delete(n);
  const mine = (r: ExistingRecord) => r.comment === MARK || taken.has(norm(r.name));
  // A name's own records beat the wildcard. Gluon's own there are only leftovers (removed below),
  // but anyone else's would quietly send that address somewhere else, so it's planned like any name.
  for (const c of covered) {
    const wildcard = wants.find((w) => w.name === c.wildcard);
    if (wildcard && !wants.some((w) => w.name === c.name) && (byName.get(c.name) ?? []).some((r) => r.comment !== MARK)) wants.push({ name: c.name, why: c.why, records: wildcard.records });
  }
  const names: NamePlan[] = [];

  for (const w of wants) {
    const have = byName.get(w.name) ?? [];
    byName.delete(w.name);
    const foreign = have.filter((r) => !mine(r));
    const row = { name: w.name, why: w.why, want: w.records, have: have.map(strip), foreign: foreign.length > 0, actions: [] as Action[] };
    if (deferred.has(w.name)) {
      names.push({ ...row, state: "deferred" });
      continue;
    }
    const exact = have.length === w.records.length && w.records.every((d) => have.some((h) => same(h, d)));
    if (exact) {
      names.push({ ...row, state: "ok" });
      continue;
    }
    if (foreign.length) {
      names.push({ ...row, state: "conflict" });
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
    names.push({ ...row, state: "change", actions });
  }

  // Without an address nothing is rewritten, so nothing Gluon made is taken away either. Records
  // handed to Gluon go the same way as its own once it no longer keeps their name.
  if (!held.length && !input.partial) {
    for (const [name, have] of byName) {
      const own = have.filter(mine);
      if (!own.length) continue;
      names.push({
        name,
        why: "No longer published",
        want: [],
        have: have.map(strip),
        state: "change",
        foreign: own.length < have.length,
        actions: own.map((h) => ({ op: "delete", name, id: h.id, record: strip(h) })),
      });
    }
  }

  const all = names.flatMap((n) => n.actions);
  const order = { delete: 0, update: 1, create: 2 } as const;
  const actions = all.map((a, i) => [a, i] as const).sort((x, y) => order[x[0].op] - order[y[0].op] || x[1] - y[1]).map(([a]) => a);
  return { names, actions, problems, covered: covered.map((c) => c.name).filter((c) => !names.some((n) => n.name === c)) };
}
