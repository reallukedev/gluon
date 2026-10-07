import type { PortReach, PublicReach, ReachOutcome } from "@/lib/network-types";

/**
 * Reading what Gluon saw when it connected to this network's public address from inside (through
 * the router, "hairpin NAT"). Pure: the probes live in reach.ts.
 *
 * A port that answers on the LAN but not on the public address only proves the router doesn't
 * forward it when some other port on that address does get through to this server. If nothing
 * answers at all, the router may simply not loop traffic back inside, so Gluon can't tell.
 */

export interface ReachProbe {
  port: number;
  proto: "tcp" | "udp";
  label: string;
  primary: boolean;
  lan: boolean;
  outside: ReachOutcome | null;
}

export interface ReachInput {
  publicIp: string | null;
  lanIp: string | null;
  gateway: string | null;
  ports: ReachProbe[];
  /** What other ports on the same address did (the web port, other services' ports). */
  controls: ReachOutcome[];
  checkedAt: number;
  /** False when Gluon didn't try (it isn't running on the server the router forwards to). */
  probed: boolean;
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const portList = (ps: { port: number }[]) => {
  const ports = [...new Set(ps.map((p) => p.port))];
  return `port${ports.length === 1 ? "" : "s"} ${list(ports.map(String))}`;
};

export function reachVerdict(input: ReachInput): PublicReach {
  const { publicIp, lanIp, gateway, checkedAt } = input;
  const where = lanIp ?? "this server's address on your network";
  const P = (p: ReachProbe) => p.proto.toUpperCase();
  const base = { checkedAt, publicIp, lanIp, gateway };

  const unknown = (why: string): PublicReach => ({
    ...base,
    hairpin: null,
    state: "unknown",
    ports: input.ports.map((p) => ({ ...p, verdict: p.lan ? "unknown" : "down", message: p.lan ? why : "Not answering on this server either." })),
    summary: why,
  });
  if (!input.probed) return unknown("Gluon only checks this when it runs on the server your router forwards to.");
  if (!publicIp) return unknown("Gluon doesn't know this network's public address, so it can't check whether people outside get through.");

  const hairpin = [...input.controls, ...input.ports.map((p) => p.outside)].includes("same");
  const ports: PortReach[] = input.ports.map((p) => {
    if (!p.lan) return { ...p, verdict: "down", message: "Not answering on this server either, so there's nothing for the router to pass on yet." };
    if (p.outside === "same") return { ...p, verdict: "reachable", message: "Reaches this server through your router." };
    if (p.outside === "other") {
      return { ...p, verdict: "elsewhere", message: `Something other than this server answers on ${P(p)} port ${p.port} at ${publicIp}. Your router probably forwards it to another device; point it at ${where} instead.` };
    }
    if (hairpin) {
      return {
        ...p,
        verdict: "not-forwarded",
        message: `Your router isn't forwarding ${P(p)} port ${p.port} to this server. In its settings${gateway ? ` (usually at http://${gateway})` : ""}, forward ${P(p)} ${p.port} to ${where}.`,
      };
    }
    return { ...p, verdict: "unknown", message: noHairpin(publicIp) };
  });

  const blocked = ports.filter((p) => p.verdict === "not-forwarded" || p.verdict === "elsewhere").sort((a, b) => Number(b.primary) - Number(a.primary));
  const live = ports.filter((p) => p.verdict !== "down");
  let state: PublicReach["state"];
  let summary: string;
  if (blocked.length) {
    state = "blocked";
    const missing = blocked.filter((p) => p.verdict === "not-forwarded");
    if (missing.length) {
      const named = missing.map((p) => `${p.port}${p.proto === "udp" ? " UDP" : ""} (${p.label.charAt(0).toLowerCase()}${p.label.slice(1)})`);
      summary = `Your router isn't forwarding ${missing.length === 1 ? "port" : "ports"} ${list(named)} to this server, so people outside can't use ${missing.length === 1 ? "it" : "them"}.`;
    } else summary = blocked[0]!.message;
  } else if (live.length && live.every((p) => p.verdict === "reachable")) {
    state = "ok";
    summary = `People outside reach ${portList(live)} through your router.`;
  } else {
    state = "unknown";
    summary = live.find((p) => p.verdict === "unknown")?.message ?? "Nothing to check until the server answers on this machine.";
  }
  return { ...base, hairpin, state, ports, summary };
}

function noHairpin(ip: string): string {
  return `Nothing answered at ${ip}, not even ports that should be open. Your router may not let devices at home use the public address, so Gluon can't tell from inside. Try connecting from a phone on mobile data.`;
}
