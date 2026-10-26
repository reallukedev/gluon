import "server-only";
import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import { certResult, explainConnectError, localBackendHost } from "./probes";
import { parseMumblePong } from "./mumble-ping";
import type { MumblePing, TlsResult } from "@/lib/network-types";

/** Probes for services that speak TLS straight away (Mumble, XMPP direct TLS) and Mumble's UDP ping. Never throw. */

export interface DirectTls {
  reachable: boolean;
  ms: number | null;
  error: string | null;
  tls: TlsResult | null;
}

/** Connect, finish a TLS handshake for `servername` and read the certificate presented. */
export function probeDirectTls(host: string, port: number, servername: string, certDays: number, who: string, timeoutMs = 4000): Promise<DirectTls> {
  const target = localBackendHost(host);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let ms: number | null = null;
    const raw = net.connect({ host: target, port });
    let secure: tls.TLSSocket | null = null;
    const finish = (r: Omit<DirectTls, "ms" | "reachable"> & { reachable?: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      secure?.destroy();
      raw.destroy();
      resolve({ reachable: r.reachable ?? ms !== null, ms, error: r.error, tls: r.tls });
    };
    const timer = setTimeout(() => finish({ error: ms === null ? explainConnectError("ETIMEDOUT") : "the TLS handshake didn't finish in time", tls: null }), timeoutMs);
    raw.once("error", (e: NodeJS.ErrnoException) => finish({ error: explainConnectError(e.code ?? null), tls: null }));
    raw.once("connect", () => {
      ms = Date.now() - t0;
      secure = tls.connect({ socket: raw, servername: net.isIP(servername) ? undefined : servername, rejectUnauthorized: false });
      secure.once("secureConnect", () => finish({ error: null, tls: certResult(secure!, servername, certDays, who) }));
      secure.once("error", (e: NodeJS.ErrnoException) => finish({ error: `the TLS handshake failed (${e.code ?? e.message})`, tls: null }));
    });
  });
}

/** Mumble's legacy UDP ping: 12 bytes out, 24 back with its version and how many people are on. */
export function mumblePing(host: string, port: number, timeoutMs = 2500): Promise<MumblePing> {
  const target = localBackendHost(host);
  const none: MumblePing = { reachable: false, ms: null, version: null, users: null, maxUsers: null };
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(target) ? "udp6" : "udp4");
    const ident = crypto.randomBytes(8);
    const t0 = Date.now();
    let done = false;
    const finish = (r: MumblePing) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish(none), timeoutMs);
    sock.on("error", () => finish(none));
    sock.on("message", (msg) => {
      const pong = parseMumblePong(msg, ident);
      if (pong) finish({ reachable: true, ms: Date.now() - t0, ...pong });
    });
    sock.send(Buffer.concat([Buffer.alloc(4), ident]), port, target, (e) => {
      if (e) finish(none);
    });
  });
}
