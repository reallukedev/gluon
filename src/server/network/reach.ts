import "server-only";
import { probeXmpp } from "./xmpp-probe";
import { probeDirectTls, mumblePing } from "./voice-probe";
import { CADDY_HOST, CADDY_PORT, tcpConnect } from "./probes";
import { defaultGateways } from "../diagnostics/checkup/probes";
import { ipAddr } from "../diagnostics/interfaces";
import type { MumblePing, ReachOutcome } from "@/lib/network-types";

/**
 * Connecting to this network's public address from inside, through the router, to see whether
 * chat and voice ports get through to this server. Every answer is checked against what the same
 * port says on the LAN (the certificate it presents, or Mumble's ping reply), so a router that
 * answers on its own public address isn't mistaken for this server.
 *
 * Only meaningful on the server the router forwards to; elsewhere (development) it stays off.
 */

export const REACH_PROBING = (process.env.GLUON_REACH_PROBE ?? (process.platform === "linux" ? "on" : "off")) === "on";
const TTL_MS = 5 * 60_000;

export type ReachTarget =
  | { kind: "xmpp-client" | "xmpp-server"; port: number; domain: string; lanFingerprint: string | null }
  | { kind: "tls"; port: number; domain: string; lanFingerprint: string | null }
  /** Mumble's TCP port: a bare connect, since HTTP or TLS there counts towards its ban. */
  | { kind: "tcp"; port: number }
  | { kind: "mumble-udp"; port: number; lan: MumblePing };

export const targetKey = (t: ReachTarget) => `${t.kind}:${t.port}:${"domain" in t ? t.domain : ""}`;
// Mumble bans an address after 10 TCP connections in 2 minutes; one every 10 minutes is far below that.
const ttlOf = (t: ReachTarget) => (t.kind === "tcp" ? 10 * 60_000 : TTL_MS);

const sameCert = (lan: string | null, outside: string | null | undefined): ReachOutcome => (!lan || !outside ? "same" : lan === outside ? "same" : "other");

async function outsideOf(ip: string, t: ReachTarget): Promise<ReachOutcome> {
  if (t.kind === "mumble-udp") {
    const p = await mumblePing(ip, t.port, 2500);
    if (!p.reachable) return "none";
    return t.lan.reachable && (p.version !== t.lan.version || p.maxUsers !== t.lan.maxUsers) ? "other" : "same";
  }
  if (t.kind === "tcp") return (await tcpConnect(ip, t.port, 4000)).ok ? "same" : "none";
  if (t.kind === "tls") {
    const r = await probeDirectTls(ip, t.port, t.domain, 0, "It", 4000);
    if (!r.reachable) return "none";
    return r.tls ? sameCert(t.lanFingerprint, r.tls.fingerprint) : "other";
  }
  const r = await probeXmpp({ host: ip, port: t.port, domain: t.domain, kind: t.kind === "xmpp-client" ? "client" : "server", certDays: 0, timeoutMs: 4000 });
  if (!r.reachable) return "none";
  // It answered but didn't behave like our chat server (no stream, wrong domain): something else.
  if (r.error && !r.tls) return "other";
  return sameCert(t.lanFingerprint, r.tls?.fingerprint);
}

type G = typeof globalThis & { __gluonReach?: Map<string, { at: number; value: ReachOutcome }>; __gluonLanSide?: { at: number; value: LanSide } };
const g = globalThis as G;
const cache = () => (g.__gluonReach ??= new Map());

/** What each target does on the public address, cached a few minutes per address and port. */
export async function outsideOutcomes(ip: string, targets: ReachTarget[], force = false): Promise<Map<string, ReachOutcome>> {
  const out = new Map<string, ReachOutcome>();
  await Promise.all(
    targets.map(async (t) => {
      const key = `${ip}|${targetKey(t)}`;
      const hit = cache().get(key);
      // "Check now" still respects Mumble's limit; everything else may run again after a minute.
      const maxAge = force ? (t.kind === "tcp" ? ttlOf(t) : 60_000) : ttlOf(t);
      if (hit && Date.now() - hit.at < maxAge) return out.set(targetKey(t), hit.value);
      const value = await outsideOf(ip, t).catch((): ReachOutcome => "none");
      cache().set(key, { at: Date.now(), value });
      out.set(targetKey(t), value);
    }),
  );
  return out;
}

/** The web port as a control: does Caddy answer on the public address with the same certificate? */
export async function webControl(ip: string, servername: string, force = false): Promise<ReachOutcome> {
  const key = `${ip}|control:${servername}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < (force ? 60_000 : TTL_MS)) return hit.value;
  const [lan, outside] = await Promise.all([probeDirectTls(CADDY_HOST, CADDY_PORT, servername, 0, "Caddy", 4000), probeDirectTls(ip, 443, servername, 0, "Caddy", 4000)]);
  const value: ReachOutcome = !outside.reachable ? "none" : !lan.tls?.fingerprint ? "same" : sameCert(lan.tls.fingerprint, outside.tls?.fingerprint);
  cache().set(key, { at: Date.now(), value });
  return value;
}

export interface LanSide {
  lanIp: string | null;
  gateway: string | null;
}

/** This server's address on the home network and the router's, from the default route. */
export async function lanSide(): Promise<LanSide> {
  if (g.__gluonLanSide && Date.now() - g.__gluonLanSide.at < 10 * 60_000) return g.__gluonLanSide.value;
  const gw = (await defaultGateways().catch(() => [])).find((x) => x.family === 4) ?? null;
  const links = await ipAddr().catch(() => []);
  const link = links.find((l) => l.ifname === gw?.dev);
  const lanIp = link?.addr_info?.find((a) => a.family === "inet")?.local ?? null;
  const value = { lanIp, gateway: gw?.gateway ?? null };
  g.__gluonLanSide = { at: Date.now(), value };
  return value;
}
