import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostPath } from "../host/paths";
import { tryReadConfig } from "../caddy/routes";
import { caddyCertificateFor } from "../network/caddy-certs";
import { certInfo, decideCopy, type CertInfo } from "../network/xmpp-cert-choice";
import { audit } from "../audit";
import { mumbleFacts, type MumbleFacts } from "./container";
import { connect, iceError, type MumbleConn } from "./ice";
import { getVoice, listVoice } from "./store";
import { envFor } from "./settings-map";
import { voiceReason } from "./cert-words";
import type { VoiceCertView } from "./types";

/**
 * Keeps a Mumble server's certificate current from the one Caddy holds for a public address.
 *
 * Mumble reads its certificate files (sslCert/sslKey) only when it starts, but Ice's
 * updateCertificate swaps it live: people already connected keep the old one, new connections get
 * the new one. So Gluon writes the files on the server (the container mounts them read-only, so
 * the write happens on the host side, keeping each file's owner and mode) and hands the same pair
 * to Mumble over Ice, with no restart. Mumble keeps that pair in its database, where it wins over
 * the files from then on; Gluon keeps both the same.
 *
 * The decision of whether to copy is the chat servers' one (decideCopy): Gluon only replaces a
 * certificate that is missing, untrusted or within 21 days of expiring.
 */

const LOCAL = process.env.GLUON_LOCAL_HOST ?? "127.0.0.1";

export interface Served {
  pem: string | null;
  trusted: boolean | null;
  subject: string | null;
  issuer: string | null;
  notAfter: number | null;
  selfSigned: boolean;
  fingerprint: string | null;
}

/**
 * The certificate Mumble serves, read over Ice rather than by connecting to its voice port: Mumble
 * counts every connection towards its autoban (10 in 2 minutes), so probing it would lock Gluon out.
 * A per-server certificate (what updateCertificate stores) wins over the config file's.
 */
export async function mumbleCert(c: MumbleConn, host: string | null): Promise<Served | null> {
  const own = await c.server.getConf("certificate").catch(() => "");
  const pem = own || (await c.meta.getDefaultConf().then((m) => m.get("certificate") ?? "", () => ""));
  const leaf = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!leaf) return null;
  try {
    const x = new crypto.X509Certificate(leaf);
    const selfSigned = x.checkIssued(x);
    return {
      pem,
      // Only what can be judged from the certificate itself: covers the name and isn't self-made.
      trusted: host ? !selfSigned && x.checkHost(host) !== undefined && Date.parse(x.validTo) > Date.now() : null,
      subject: /CN=([^\n,]+)/.exec(x.subject)?.[1] ?? null,
      issuer: /(?:O|CN)=([^\n,]+)/.exec(x.issuer)?.[1] ?? null,
      notAfter: Date.parse(x.validTo),
      selfSigned,
      fingerprint: x.fingerprint256,
    };
  } catch {
    return null;
  }
}

/** The host folder holding Mumble's certificate files, from its sslCert setting and its mounts. */
export function certFiles(f: Pick<MumbleFacts, "env" | "mounts">): { crt: string; key: string; folder: string } | null {
  const crtIn = envFor("sslCert", f.env)?.value;
  const keyIn = envFor("sslKey", f.env)?.value;
  if (!crtIn || !keyIn) return null;
  const toHost = (p: string) => {
    const m = f.mounts
      .filter((x) => x.type === "bind" && (p === x.destination || p.startsWith(`${x.destination.replace(/\/+$/, "")}/`)))
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    return m ? path.posix.join(m.source, path.posix.relative(m.destination, p)) : null;
  };
  const crt = toHost(crtIn);
  const key = toHost(keyIn);
  if (!crt || !key) return null;
  return { crt, key, folder: path.posix.dirname(crt) };
}

/** Write `data` over a host file, keeping its owner and mode (or the folder's owner, 0644/0600, when new). */
function writeKeeping(file: string, data: Buffer, newMode: number) {
  const p = hostPath(file);
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(p);
  } catch {
    st = null;
  }
  const dir = fs.statSync(path.dirname(p));
  const tmp = `${p}.gluon-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: st ? st.mode & 0o777 : newMode });
  try {
    fs.chownSync(tmp, st?.uid ?? dir.uid, st?.gid ?? dir.gid);
  } catch {
    /* not root (development) */
  }
  fs.chmodSync(tmp, st ? st.mode & 0o777 : newMode);
  fs.renameSync(tmp, p);
}

export interface CertSync {
  ok: boolean;
  message: string;
  checkedAt: number;
  copiedAt: number | null;
}

type G = typeof globalThis & { __gluonVoiceCerts?: { state: Map<string, CertSync>; running: Promise<void> | null } };
const g = globalThis as G;
const st = () => (g.__gluonVoiceCerts ??= { state: new Map(), running: null });

export const certSyncState = (appId: string) => st().state.get(appId) ?? null;

/** Check one voice server and copy Caddy's certificate in when it's due. */
export async function syncVoiceCert(appId: string, opts: { force?: boolean } = {}): Promise<CertSync> {
  const rec = getVoice(appId);
  const prev = st().state.get(appId);
  const base = { checkedAt: Date.now(), copiedAt: prev?.copiedAt ?? null };
  const done = (ok: boolean, message: string, copied = false): CertSync => {
    const r = { ...base, ok, message: voiceReason(message), copiedAt: copied ? Date.now() : base.copiedAt };
    st().state.set(appId, r);
    return r;
  };
  const domain = rec?.certDomain;
  if (!rec || !domain) return done(true, "");
  const f = await mumbleFacts(appId);
  if (!f.running) return done(false, "The voice server is stopped, so Gluon couldn't check its certificate.");
  if (!f.icePort || !rec.secrets) return done(false, "Gluon can't reach Mumble's admin connection to load a new certificate.");
  let c: MumbleConn;
  try {
    c = await connect({ host: LOCAL, port: f.icePort, secret: rec.secrets.write });
  } catch (e) {
    return done(false, `Gluon couldn't reach Mumble's admin connection: ${iceError(e).message}`);
  }

  const caddy = await caddyCertificateFor(domain);
  const src = caddy ? certInfo(caddy.crt, domain) : null;
  const served = await mumbleCert(c, domain);
  const dst: CertInfo | null = served?.pem ? certInfo(served.pem, domain) : null;
  const decision = decideCopy(src, dst, domain, Date.now(), served?.trusted ?? null);
  if (!decision.copy && !opts.force) return done(decision.ok, decision.reason);
  if (!caddy || !src) return done(false, decision.reason);

  // Files first (so a restart keeps it), then the live swap.
  const files = certFiles(f);
  let wrote = false;
  if (files) {
    try {
      writeKeeping(files.crt, caddy.crt, 0o644);
      writeKeeping(files.key, caddy.key, 0o600);
      wrote = true;
    } catch (e) {
      return done(false, `Gluon couldn't write the certificate into ${files.folder}: ${(e as Error).message}.`);
    }
  }
  try {
    await c.server.updateCertificate(caddy.crt.toString(), caddy.key.toString(), "");
  } catch (e) {
    return done(false, `${wrote ? "Gluon wrote the new certificate files, but " : ""}Mumble didn't take the new certificate: ${iceError(e, "Loading it").message}`);
  }
  const until = new Date(caddy.notAfter).toISOString().slice(0, 10);
  audit(null, { action: "voice.cert", target: appId, summary: `Gave ${f.app.name} the certificate for ${domain}`, detail: { domain, validUntil: until, files: files?.folder ?? null, why: voiceReason(decision.reason) } });
  const after = await mumbleCert(c, domain);
  if (after?.fingerprint === caddy.fingerprint) return done(true, `Mumble now uses Caddy's certificate for ${domain}, valid until ${until}. People who were already connected keep the old one until they reconnect.`, true);
  return done(false, `Gluon gave Mumble the certificate for ${domain}, but it still reports ${after?.fingerprint ? "another one" : "none Gluon could read"}. Restart the voice server to load it.`, true);
}

const RECHECK_OK_MS = 6 * 60 * 60_000;

/** Every voice server that follows an address. `onlyDue` skips ones checked recently that were fine. */
export function syncVoiceCertificates(opts: { onlyDue?: boolean } = {}): Promise<void> {
  const s = st();
  if (s.running) return s.running;
  s.running = (async () => {
    for (const rec of listVoice()) {
      if (!rec.certDomain) {
        s.state.delete(rec.appId);
        continue;
      }
      const prev = s.state.get(rec.appId);
      if (opts.onlyDue && prev?.ok && Date.now() - prev.checkedAt < RECHECK_OK_MS) continue;
      try {
        await syncVoiceCert(rec.appId);
      } catch (e) {
        s.state.set(rec.appId, { ok: false, message: `Couldn't check the certificate: ${(e as Error).message}`, checkedAt: Date.now(), copiedAt: prev?.copiedAt ?? null });
      }
    }
  })().finally(() => {
    s.running = null;
  });
  return s.running;
}

/** Public addresses whose certificate Mumble could use: voice addresses and this app's first. */
export function certChoices(appId: string): string[] {
  const cfg = tryReadConfig();
  const subs = (cfg?.routes ?? []).filter((r) => r.type === "subdomain" && r.enabled !== false && !r.redirect_to);
  const rank = (r: (typeof subs)[number]) => (r.type === "subdomain" && r.voice ? 0 : r.app === appId ? 1 : 2);
  return [...subs].sort((a, b) => rank(a) - rank(b)).map((r) => (r as { host: string }).host);
}

export async function certView(appId: string, f: MumbleFacts | null, c: MumbleConn | null): Promise<VoiceCertView> {
  const rec = getVoice(appId);
  const domain = rec?.certDomain ?? null;
  const files = f ? certFiles(f) : null;
  const served = c ? await mumbleCert(c, domain) : null;
  let writable = false;
  if (files) {
    try {
      fs.accessSync(hostPath(files.folder), fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  const sync = certSyncState(appId);
  return {
    domain,
    choices: certChoices(appId),
    folder: files?.folder ?? null,
    writable,
    served: served ? { subject: served.subject, issuer: served.issuer, notAfter: served.notAfter, selfSigned: served.selfSigned, fingerprint: served.fingerprint } : null,
    sync: sync && domain ? sync : null,
    blocked: !rec?.secrets ? "Let Gluon manage this voice server first; it loads new certificates through Mumble's admin connection." : null,
  };
}

/**
 * Stop following an address. Mumble's own copy (from updateCertificate) would otherwise keep
 * winning over the files forever, so it's cleared: Mumble serves the current certificate until it
 * restarts, then reads its files again.
 */
export async function releaseCert(appId: string): Promise<string> {
  const rec = getVoice(appId);
  const f = await mumbleFacts(appId);
  if (!rec?.secrets || !f.running || !f.icePort) return "Gluon stopped keeping Mumble's certificate current.";
  try {
    const c = await connect({ host: LOCAL, port: f.icePort, secret: rec.secrets.write });
    await c.server.setConf("certificate", "");
    await c.server.setConf("key", "");
  } catch (e) {
    return `Gluon stopped keeping it current, but couldn't clear Mumble's copy: ${iceError(e).message}`;
  }
  const files = certFiles(f);
  return files ? `Mumble serves the same certificate until it restarts, then reads ${files.folder} again.` : "Mumble serves the same certificate until it restarts, then goes back to its own.";
}
