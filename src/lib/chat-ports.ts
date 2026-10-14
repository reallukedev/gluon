/**
 * The host ports a Quark install publishes. Sign-in, direct TLS, federation and the web side are
 * remapped on the host only (inside the container they stay standard); the call relay keeps the
 * same port on both sides because it tells chat apps where to send calls. Shared with the client.
 */
export interface QuarkPorts {
  /** Chat apps sign in (STARTTLS). Container port 5222. */
  c2s: number;
  /** Chat apps sign in with TLS from the start. Container port 5223. */
  tls: number;
  /** Other chat servers (federation). Container port 5269. */
  s2s: number;
  /** Web chat, file uploads and invite pages, reached through Caddy. Container port 5280. */
  http: number;
  /** The call relay's TURN port, TCP and UDP. */
  turn: number;
  /** The UDP range calls are relayed on. */
  relayMin: number;
  relayMax: number;
}

/** What Quark listens on inside its container. */
export const QUARK_CONTAINER_PORTS = { c2s: 5222, tls: 5223, s2s: 5269, http: 5280 } as const;

export const QUARK_PORTS: QuarkPorts = { c2s: 5222, tls: 5223, s2s: 5269, http: 5280, turn: 3478, relayMin: 49160, relayMax: 49200 };

/** Tried in order when another chat server (or anything else) holds the standard ports. */
export const QUARK_ALT_PORTS: readonly QuarkPorts[] = [
  { c2s: 5322, tls: 5323, s2s: 5369, http: 5380, turn: 3479, relayMin: 49210, relayMax: 49250 },
  { c2s: 5422, tls: 5423, s2s: 5469, http: 5480, turn: 3480, relayMin: 49260, relayMax: 49300 },
];

export const QUARK_PORT_SETS: readonly QuarkPorts[] = [QUARK_PORTS, ...QUARK_ALT_PORTS];

export const isStandardPorts = (p: QuarkPorts) => (Object.keys(QUARK_PORTS) as (keyof QuarkPorts)[]).every((k) => p[k] === QUARK_PORTS[k]);

/**
 * The first port set nothing on the server uses yet. `conflicts` says what's in the way of one
 * set (empty when it's free). When every set is taken, the answer carries the standard set's
 * conflicts so the person hears about the ports they'd expect.
 */
export async function pickPortSet<T>(sets: readonly T[], conflicts: (set: T) => Promise<string[]>): Promise<{ ports: T | null; conflicts: string[] }> {
  let first: string[] | null = null;
  for (const set of sets) {
    const c = await conflicts(set);
    if (!c.length) return { ports: set, conflicts: [] };
    first ??= c;
  }
  return { ports: null, conflicts: first ?? [] };
}

/** The DNS records chat apps and other servers need to find Quark on non-standard ports. */
export function srvRecords(domain: string, p: QuarkPorts): { name: string; port: number }[] {
  return [
    { name: `_xmpp-client._tcp.${domain}`, port: p.c2s },
    { name: `_xmpps-client._tcp.${domain}`, port: p.tls },
    { name: `_xmpp-server._tcp.${domain}`, port: p.s2s },
  ];
}

/** What the person has to do when Quark gets the alternate ports: in sentences, for the flow and the final notes. */
export function alternatePortNotes(domain: string, p: QuarkPorts): string[] {
  const srv = srvRecords(domain, p)
    .map((r) => `${r.name} pointing at ${domain} port ${r.port}`)
    .join(", ");
  return [
    `Another chat server already uses the standard chat ports, so Quark uses ${p.c2s} for chat apps, ${p.tls} for chat apps with TLS, ${p.s2s} for other chat servers, ${p.http} for its web side and ${p.turn} for calls.`,
    `Chat apps and other servers only find those ports through DNS SRV records. Add these at your DNS provider: ${srv}.`,
    `On your router, forward TCP ${p.c2s}, ${p.tls} and ${p.s2s}, TCP and UDP ${p.turn}, and UDP ${p.relayMin}-${p.relayMax} to this server.`,
  ];
}

/**
 * Read the ports back from a running Quark container's published mappings, falling back to
 * `fallback` for anything missing. The relay is the mapping with the same port on both sides.
 */
export function quarkPortsFrom(mappings: { host: number; container: number; proto: "tcp" | "udp" }[], fallback: QuarkPorts = QUARK_PORTS): QuarkPorts {
  const hostOf = (container: number) => mappings.find((m) => m.proto === "tcp" && m.container === container)?.host ?? null;
  const fixed = new Set<number>(Object.values(QUARK_CONTAINER_PORTS));
  const same = mappings.filter((m) => m.host === m.container && !fixed.has(m.container));
  const turn = same.find((m) => m.proto === "tcp")?.container ?? null;
  const relay = same.filter((m) => m.proto === "udp" && m.container !== turn).map((m) => m.container);
  return {
    c2s: hostOf(QUARK_CONTAINER_PORTS.c2s) ?? fallback.c2s,
    tls: hostOf(QUARK_CONTAINER_PORTS.tls) ?? fallback.tls,
    s2s: hostOf(QUARK_CONTAINER_PORTS.s2s) ?? fallback.s2s,
    http: hostOf(QUARK_CONTAINER_PORTS.http) ?? fallback.http,
    turn: turn ?? fallback.turn,
    relayMin: relay.length ? Math.min(...relay) : fallback.relayMin,
    relayMax: relay.length ? Math.max(...relay) : fallback.relayMax,
  };
}
