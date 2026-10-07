import crypto from "node:crypto";
import type { TarEntry } from "./tarball";

/** Which certificate a chat server should have: pure decisions, no Docker or disk access. */

export interface CertInfo {
  fingerprint: string;
  notAfter: number;
  covers: boolean;
  /** Signed by itself (prosodyctl cert generate, Caddy's internal CA root): chat apps refuse it. */
  selfIssued: boolean;
}

export type CopyDecision = { copy: true; reason: string } | { copy: false; ok: boolean; reason: string };

/** The first certificate in a PEM bundle (the leaf, for Caddy's chain files). */
export function certInfo(pem: Buffer | string, host: string): CertInfo | null {
  const text = pem.toString();
  const m = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!m) return null;
  try {
    const x = new crypto.X509Certificate(m[0]);
    return { fingerprint: x.fingerprint256, notAfter: Date.parse(x.validTo), covers: x.checkHost(host) !== undefined, selfIssued: x.checkIssued(x) };
  } catch {
    return null;
  }
}

/**
 * Gluon is a safety net, not the only renewer: a chat server whose certificate is valid and not
 * close to expiring is left alone, since another tool (certbot, the server itself) may manage it
 * and copying over it at every renewal would make the two take turns. Caddy renews about 30 days
 * ahead, so by the time a certificate is within this window Caddy has a fresher one.
 */
export const COPY_WITHIN_DAYS = 21;

const DAY = 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * `servedTrusted` is what chat apps actually saw on the client port (false when the chain didn't
 * verify), so a certificate that looks fine on disk but isn't trusted still gets replaced.
 */
export function decideCopy(src: CertInfo | null, dst: CertInfo | null, host: string, now = Date.now(), servedTrusted: boolean | null = null, from: "caddy" | "own" = "caddy"): CopyDecision {
  const usable = (c: CertInfo | null): c is CertInfo => !!c && c.covers && !c.selfIssued;
  const theirs = from === "own" ? "your certificate" : "Caddy's";
  const Theirs = from === "own" ? "Your certificate" : "Caddy's certificate";
  const dstOk = usable(dst) && servedTrusted !== false;
  if (dstOk && src && dst.fingerprint === src.fingerprint) return { copy: false, ok: true, reason: `The chat server has ${from === "own" ? "your" : "Caddy's"} current certificate, valid until ${day(dst.notAfter)}.` };
  if (dstOk && dst.notAfter - now > COPY_WITHIN_DAYS * DAY) {
    return { copy: false, ok: true, reason: `The chat server's own certificate is valid until ${day(dst.notAfter)}. Gluon copies in ${theirs} if it gets within ${COPY_WITHIN_DAYS} days of expiring.` };
  }
  if (!src) return { copy: false, ok: false, reason: from === "own" ? `Gluon doesn't have your certificate for ${host}. Add it in the address's HTTPS settings.` : `Caddy has no certificate for ${host} yet. It gets one once the name resolves to this server.` };
  if (from === "caddy" && !usable(src)) return { copy: false, ok: false, reason: `Caddy's certificate doesn't cover ${host}.` };
  if (!src.covers) return { copy: false, ok: false, reason: `${Theirs} doesn't cover ${host}.` };
  if (src.notAfter <= now) return { copy: false, ok: false, reason: from === "own" ? `Your certificate for ${host} has expired. Replace it in the address's HTTPS settings.` : `Caddy's certificate for ${host} has expired. Check Network for why it wasn't renewed.` };
  if (dstOk && dst.notAfter >= src.notAfter) return { copy: false, ok: false, reason: `The chat server's certificate expires on ${day(dst.notAfter)}, and ${from === "own" ? "yours doesn't last longer" : "Caddy doesn't have a newer one yet"}.` };
  const why = !dst
    ? `The chat server has no certificate for ${host} yet.`
    : !dst.covers
      ? `The chat server's certificate doesn't cover ${host}.`
      : dst.selfIssued || servedTrusted === false
        ? "The chat server's certificate isn't trusted by chat apps."
        : "The chat server's certificate is close to expiring.";
  return { copy: true, reason: why };
}

/** Caddy's certificate and key for `host`, from whichever issuer has the one that lasts longest. */
export function pickCaddyPair(entries: TarEntry[], host: string): { crt: Buffer; key: Buffer; info: CertInfo } | null {
  const files = new Map(entries.filter((e) => e.type === "file").map((e) => [e.name, e.data]));
  let best: { crt: Buffer; key: Buffer; info: CertInfo } | null = null;
  for (const [name, data] of files) {
    // certificates/local/... is Caddy's internal CA, which chat apps don't trust.
    if (!name.endsWith(`/${host}/${host}.crt`) || name.split("/").includes("local")) continue;
    const key = files.get(name.replace(/\.crt$/, ".key"));
    const info = certInfo(data, host);
    if (!key || !info || !info.covers || info.selfIssued) continue;
    if (!keyMatches(data, key)) continue;
    if (!best || info.notAfter > best.info.notAfter) best = { crt: data, key, info };
  }
  return best;
}

function keyMatches(crt: Buffer, key: Buffer): boolean {
  try {
    const leaf = crt.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    return !!leaf && new crypto.X509Certificate(leaf).checkPrivateKey(crypto.createPrivateKey(key));
  } catch {
    return false;
  }
}
