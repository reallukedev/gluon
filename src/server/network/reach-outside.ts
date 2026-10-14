import type { MumblePing, ReachOutcome } from "@/lib/network-types";

/**
 * Asking a machine on the internet whether a port is open on this network's public address, for the
 * ports that didn't answer when Gluon tried them through the router from inside. Some routers (AT&T's
 * BGW320, for one) loop some forwarded ports back inside and silently drop others, so a port that's
 * closed from inside can still be open to everyone else.
 *
 * The outside source is portchecker.io: a free service that opens a TCP connection to the address and
 * ports it's given and says which ones accepted. It only sees the public address and port numbers.
 * It can't tell UDP, or whose server answered, so it only settles TCP ports that loopback called closed.
 *
 * Pure apart from the default checker, so the batching and caching can be tested with a fake one.
 */

export type ReachTarget =
  | { kind: "xmpp-client" | "xmpp-server"; port: number; domain: string; lanFingerprint: string | null }
  | { kind: "tls"; port: number; domain: string; lanFingerprint: string | null }
  /** Mumble's TCP port: a bare connect, since HTTP or TLS there counts towards its ban. */
  | { kind: "tcp"; port: number }
  | { kind: "mumble-udp"; port: number; lan: MumblePing };

export const targetKey = (t: ReachTarget) => `${t.kind}:${t.port}:${"domain" in t ? t.domain : ""}`;

const TTL_MS = 5 * 60_000;
// Mumble bans an address after 10 TCP connections in 2 minutes; one every 10 minutes is far below that.
const ttlOf = (t: ReachTarget) => (t.kind === "tcp" ? 10 * 60_000 : TTL_MS);
/** How old a cached answer may be. "Check now" still respects Mumble's limit; everything else may run again after a minute. */
export const maxAgeOf = (t: ReachTarget, force: boolean) => (force ? (t.kind === "tcp" ? ttlOf(t) : 60_000) : ttlOf(t));

/** Which of `ports` accept a TCP connection on `ip`, seen from the internet. Throws when it can't tell. */
export type PortChecker = (ip: string, ports: number[]) => Promise<Map<number, boolean>>;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const portcheckerIo: PortChecker = async (ip, ports) => {
  if (!IPV4.test(ip)) throw new Error("portchecker.io only checks IPv4 addresses");
  const res = await fetch("https://portchecker.io/api/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: ip, ports }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`portchecker.io answered ${res.status}`);
  const body = (await res.json()) as { error?: unknown; check?: unknown };
  if (body.error !== false || !Array.isArray(body.check)) throw new Error("portchecker.io couldn't check");
  const out = new Map<number, boolean>();
  for (const c of body.check as { port?: unknown; status?: unknown }[]) {
    if (typeof c?.port === "number" && typeof c.status === "boolean") out.set(c.port, c.status);
  }
  return out;
};

const TCP_KINDS: ReadonlySet<ReachTarget["kind"]> = new Set(["xmpp-client", "xmpp-server", "tls", "tcp"]);

/** Open, closed, or null when the outside check failed. */
export type OutsideCache = Map<string, { at: number; open: boolean | null }>;

/**
 * Settles every TCP target loopback called "none" with one request to `checker`: open becomes
 * "same", closed stays "none", and a failed check becomes "unconfirmed" so nobody blames the router
 * on loopback's word alone. Answers, failures included, are cached per address and port.
 */
export async function confirmFromOutside(
  ip: string,
  targets: ReachTarget[],
  loopback: Map<string, ReachOutcome>,
  opts: { checker: PortChecker; cache: OutsideCache; force?: boolean; now?: () => number },
): Promise<Map<string, ReachOutcome>> {
  const now = opts.now ?? Date.now;
  const out = new Map(loopback);
  const doubted = targets.filter((t) => TCP_KINDS.has(t.kind) && loopback.get(targetKey(t)) === "none");
  if (!doubted.length) return out;

  const keyOf = (port: number) => `${ip}|outside:${port}`;
  const known = new Map<number, boolean | null>();
  const stale = new Set<number>();
  for (const t of doubted) {
    const hit = opts.cache.get(keyOf(t.port));
    if (hit && now() - hit.at < maxAgeOf(t, opts.force ?? false)) known.set(t.port, hit.open);
    else stale.add(t.port);
  }

  if (stale.size) {
    const ports = [...stale].sort((a, b) => a - b);
    const answers = await opts.checker(ip, ports).catch(() => null);
    const at = now();
    for (const port of ports) {
      const open = answers?.get(port) ?? null;
      opts.cache.set(keyOf(port), { at, open });
      known.set(port, open);
    }
  }

  for (const t of doubted) {
    const open = known.get(t.port) ?? null;
    out.set(targetKey(t), open === null ? "unconfirmed" : open ? "same" : "none");
  }
  return out;
}
