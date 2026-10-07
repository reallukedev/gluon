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
const NS_TLS = "urn:ietf:params:xml:ns:xmpp-tls";
const NS_REGISTER = "http://jabber.org/features/iq-register";

const FEATURES_RE = /<stream:features\s*\/>|<stream:features\b[^>]*>[\s\S]*?<\/stream:features>/;
const STREAM_ERROR_RE = /<stream:error\b[\s\S]*?<([a-z-]+)\s+xmlns=['"]urn:ietf:params:xml:ns:xmpp-streams['"]/;

export function streamHeader(domain: string, kind: "client" | "server"): string {
  return `<?xml version='1.0'?><stream:stream xmlns='jabber:${kind}' xmlns:stream='${NS_STREAM}' to='${domain}' version='1.0'>`;
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
 * presents for `domain`. For client streams it also restarts the stream once encrypted to see
 * whether anyone can sign up.
 */
export function probeXmpp(opts: { host: string; port: number; domain: string; kind: "client" | "server"; certDays: number; timeoutMs?: number }): Promise<XmppHandshake> {
  const { port, domain, kind, certDays } = opts;
  const target = localBackendHost(opts.host);
  const t0 = Date.now();
  const empty: XmppHandshake = { port, reachable: false, ms: null, error: null, tls: null, openRegistration: null };
  return new Promise((resolve) => {
    let done = false;
    let ms: number | null = null;
    let tlsResult: TlsResult | null = null;
    let secure: tls.TLSSocket | null = null;
    let buf = "";
    let stage: "features" | "proceed" | "secure-features" = "features";

    const plain = net.connect({ host: target, port });
    const finish = (r: Partial<XmppHandshake>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        (secure ?? plain).write("</stream:stream>");
      } catch {
        /* already closed */
      }
      secure?.destroy();
      plain.destroy();
      resolve({ ...empty, reachable: ms !== null, ms, tls: tlsResult, ...r });
    };
    const timer = setTimeout(() => {
      const where = stage === "features" ? "didn't answer the stream" : stage === "proceed" ? "didn't start encryption" : "didn't answer once encrypted";
      finish(ms === null ? { error: explainConnectError("ETIMEDOUT") } : { error: `the chat server ${where} in time` });
    }, opts.timeoutMs ?? 6000);

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const err = streamError(buf);
      if (err) return finish({ error: explainStreamError(err, domain) });
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
        upgrade();
      } else if (FEATURES_RE.test(buf)) {
        finish({ openRegistration: parseFeatures(buf).register });
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
        if (kind === "server") return finish({});
        stage = "secure-features";
        secure!.on("data", onData);
        secure!.write(streamHeader(domain, kind));
      });
      secure.once("error", (e: NodeJS.ErrnoException) => finish({ error: `encryption failed (${e.code ?? e.message})` }));
    };

    plain.once("connect", () => {
      ms = Date.now() - t0;
      plain.write(streamHeader(domain, kind));
    });
    plain.on("data", onData);
    plain.once("error", (e: NodeJS.ErrnoException) => finish({ error: explainConnectError(e.code ?? null) }));
    plain.once("close", () => {
      if (!done) finish({ error: ms === null ? explainConnectError("ECONNRESET") : "the chat server closed the connection" });
    });
  });
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
