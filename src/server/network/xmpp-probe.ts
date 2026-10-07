import "server-only";
import net from "node:net";
import tls from "node:tls";
import { certResult, explainConnectError, localBackendHost, resolver } from "./probes";
import type { SrvRecord, SrvResult, TlsResult, XmppPortResult } from "@/lib/network-types";

/**
 * Chat server (XMPP) probes. Like the other probes they never throw and always time out:
 * failures come back as data with a sentence a person can act on.
 */

const NS_STREAM = "http://etherx.jabber.org/streams";
const PROBE_FROM = "status-check.gluon.invalid";
const NS_TLS = "urn:ietf:params:xml:ns:xmpp-tls";
const NS_REGISTER = "http://jabber.org/features/iq-register";

const FEATURES_RE = /<stream:features\s*\/>|<stream:features\b[^>]*>[\s\S]*?<\/stream:features>/;
const STREAM_ERROR_RE = /<stream:error\b[\s\S]*?<([a-z-]+)\s+xmlns=['"]urn:ietf:params:xml:ns:xmpp-streams['"]/;

/**
 * The opening of a stream. Server streams name who's asking (`from`), as federation peers do, so
 * the chat server logs the probe by name instead of as a malformed stream from an unknown host.
 */
export function streamHeader(domain: string, kind: "client" | "server", from?: string): string {
  return `<?xml version='1.0'?><stream:stream xmlns='jabber:${kind}' xmlns:stream='${NS_STREAM}' to='${domain}'${kind === "server" && from ? ` from='${from}'` : ""} version='1.0'>`;
}

/** What a <stream:features/> block offers. */
export function parseFeatures(xml: string): { starttls: boolean; register: boolean } {
  const m = xml.match(FEATURES_RE);
  const f = m ? m[0] : "";
  return {
    starttls: new RegExp(`<starttls[^>]*xmlns=['"]${NS_TLS}['"]`).test(f),
    register: new RegExp(`<register[^>]*xmlns=['"]${NS_REGISTER}['"]`).test(f),
  };
}

/** The condition of a <stream:error/>, e.g. "host-unknown". */
export function streamError(xml: string): string | null {
  return xml.match(STREAM_ERROR_RE)?.[1] ?? null;
}

function explainStreamError(condition: string, domain: string): string {
  switch (condition) {
    case "host-unknown":
      return `the chat server doesn't host ${domain} (check its VirtualHost setting)`;
    case "policy-violation":
      return "the chat server refused the connection by policy";
    case "system-shutdown":
      return "the chat server is shutting down";
    default:
      return `the chat server closed the stream (${condition})`;
  }
}

export interface XmppHandshake extends XmppPortResult {
  /** In-band registration offered after STARTTLS (client streams only). */
  openRegistration: boolean | null;
}

/**
 * Open an XMPP stream to the chat server, upgrade it with STARTTLS and read the certificate it
 * presents for `domain`. Client streams restart once encrypted, as apps do, to see whether anyone
 * can sign up; every stream is closed politely, so the chat server logs an ordinary short session.
 */
export function probeXmpp(opts: { host: string; port: number; domain: string; kind: "client" | "server"; certDays: number; timeoutMs?: number; from?: string }): Promise<XmppHandshake> {
  const { port, domain, kind, certDays } = opts;
  // A host the chat server doesn't serve (it refuses streams "from" itself), clearly not a real peer.
  const from = opts.from ?? PROBE_FROM;
  const target = localBackendHost(opts.host);
  const t0 = Date.now();
  const empty: XmppHandshake = { port, reachable: false, ms: null, error: null, tls: null, openRegistration: null };
  return new Promise((resolve) => {
    let done = false;
    let ms: number | null = null;
    let tlsResult: TlsResult | null = null;
    let secure: tls.TLSSocket | null = null;
    // Whether a stream is open on the current layer, so the close is well-formed.
    let open = false;
    let buf = "";
    let stage: "features" | "proceed" | "secure-features" = "features";

    const plain = net.connect({ host: target, port });
    const finish = (r: Partial<XmppHandshake>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const sock = secure ?? plain;
      try {
        if (open) sock.write("</stream:stream>");
        sock.end();
      } catch {
        /* already closed */
      }
      // Give the close a moment to reach the server, then make sure nothing lingers.
      setTimeout(() => {
        secure?.destroy();
        plain.destroy();
      }, 500).unref?.();
      resolve({ ...empty, reachable: ms !== null, ms, tls: tlsResult, ...r });
    };
    const timer = setTimeout(() => {
      const where = stage === "features" ? "didn't answer the stream" : stage === "proceed" ? "didn't start encryption" : "didn't answer once encrypted";
      finish(ms === null ? { error: explainConnectError("ETIMEDOUT") } : { error: `the chat server ${where} in time` });
    }, opts.timeoutMs ?? 6000);

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const err = streamError(buf);
      if (err) {
        open = false;
        return finish({ error: explainStreamError(err, domain) });
      }
      if (stage === "features") {
        if (!FEATURES_RE.test(buf)) return;
        if (!parseFeatures(buf).starttls) return finish({ error: "the chat server doesn't offer encryption (STARTTLS) on this port" });
        buf = "";
        stage = "proceed";
        plain.write(`<starttls xmlns='${NS_TLS}'/>`);
      } else if (stage === "proceed") {
        if (/<failure\b/.test(buf)) return finish({ error: "the chat server refused to start encryption" });
        if (!/<proceed\b/.test(buf)) return;
        plain.removeListener("data", onData);
        buf = "";
        // The plain stream ends with the TLS handshake; a new one starts once encrypted.
        open = false;
        upgrade();
      } else if (FEATURES_RE.test(buf)) {
        finish({ openRegistration: kind === "client" ? parseFeatures(buf).register : null });
      }
    };

    const upgrade = () => {
      secure = tls.connect({ socket: plain, servername: domain, rejectUnauthorized: false });
      secure.once("secureConnect", () => {
        tlsResult = certResult(secure!, domain, certDays, "The chat server") ?? {
          servername: domain,
          status: "error",
          issuer: null,
          subject: null,
          names: [],
          validFrom: null,
          validTo: null,
          daysLeft: null,
          trusted: null,
          issueError: null,
          message: `The chat server sent no certificate for ${domain}.`,
        };
        // A federation peer would now prove who it is with its own certificate; the probe can't,
        // so it leaves after the handshake instead of opening a stream the server would refuse.
        if (kind === "server") return finish({});
        stage = "secure-features";
        secure!.on("data", onData);
        secure!.write(streamHeader(domain, kind, from));
        open = true;
      });
      secure.once("error", (e: NodeJS.ErrnoException) => finish({ error: `encryption failed (${e.code ?? e.message})` }));
    };

    plain.once("connect", () => {
      ms = Date.now() - t0;
      plain.write(streamHeader(domain, kind, from));
      open = true;
    });
    plain.on("data", onData);
    plain.once("error", (e: NodeJS.ErrnoException) => finish({ error: explainConnectError(e.code ?? null) }));
    plain.once("close", () => {
      open = false;
      if (!done) finish({ error: ms === null ? explainConnectError("ECONNRESET") : "the chat server closed the connection" });
    });
  });
}

type G = typeof globalThis & { __gluonXmppProbes?: Map<string, { at: number; value: Promise<XmppHandshake> }> };
const probeCache = () => ((globalThis as G).__gluonXmppProbes ??= new Map());

/**
 * probeXmpp, reused for a few minutes. The Network page polls every 30 seconds; the chat server
 * shouldn't see a session that often. Concurrent callers share one probe.
 */
export function probeXmppCached(opts: Parameters<typeof probeXmpp>[0], maxAgeMs = 3 * 60_000): Promise<XmppHandshake> {
  const key = `${opts.kind}|${opts.host}|${opts.port}|${opts.domain}`;
  const hit = probeCache().get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = probeXmpp(opts);
  probeCache().set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- SRV

/**
 * Judge the SRV records for a service. No record is fine when the server listens on the standard
 * port at the domain itself, since that's where apps look next.
 */
export function judgeSrv(name: string, records: SrvRecord[], domain: string, expectedPort: number | null, standardPort: number, label: string, who = "Apps"): SrvResult {
  if (expectedPort === null) {
    const disabled = records.length === 1 && records[0]!.target === ".";
    return { name, records, status: "ok", message: disabled || !records.length ? `${label} is turned off.` : `${label} is turned off here, but ${name} still advertises it.` };
  }
  if (!records.length) {
    if (expectedPort === standardPort) return { name, records, status: "missing", message: `No ${name} record. ${who} fall back to ${domain} on port ${standardPort}, which is where the server listens.` };
    return { name, records, status: "mismatch", message: `No ${name} record, so ${who.toLowerCase()} try port ${standardPort}, but the chat server listens on ${expectedPort}. Add an SRV record pointing at ${domain}:${expectedPort}.` };
  }
  if (records.some((r) => r.target === ".")) return { name, records, status: "mismatch", message: `${name} says this service isn't offered (target "."), so ${label.toLowerCase()} won't work.` };
  const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]!;
  if (!records.some((r) => r.port === expectedPort)) {
    return { name, records, status: "mismatch", message: `${name} sends ${who.toLowerCase()} to ${best.target}:${best.port}, but the chat server listens on port ${expectedPort}.` };
  }
  return { name, records, status: "ok", message: `Points to ${best.target}:${best.port}.` };
}

export async function resolveSrv(name: string): Promise<{ records: SrvRecord[]; error: string | null }> {
  try {
    const list = await resolver().resolveSrv(name);
    return { records: list.map((r) => ({ target: r.name.replace(/\.$/, "") || ".", port: r.port, priority: r.priority, weight: r.weight })), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return { records: [], error: null };
    return { records: [], error: code || (e as Error).message };
  }
}

export async function checkSrv(service: "xmpp-client" | "xmpp-server", domain: string, expectedPort: number | null, standardPort: number): Promise<SrvResult> {
  const name = `_${service}._tcp.${domain}`;
  const label = service === "xmpp-client" ? "Signing in from chat apps" : "Talking to other chat servers";
  const { records, error } = await resolveSrv(name);
  if (error) return { name, records: [], status: "error", message: `Couldn't look up ${name} (${error}).` };
  return judgeSrv(name, records, domain, expectedPort, standardPort, label, service === "xmpp-client" ? "Apps" : "Other servers");
}
