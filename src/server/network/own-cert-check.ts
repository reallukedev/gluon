import crypto from "node:crypto";
import type { OwnCertInfo } from "@/lib/network-types";

/**
 * Checking a certificate someone supplies for an address: pure, so the editor's "check" and the
 * save run the same rules. The key is only used to prove it belongs to the certificate.
 */

/** Gluon can't renew a certificate someone else supplies, so it speaks up this long before it ends. */
export const OWN_CERT_WARN_DAYS = 21;
const MAX_PEM = 64 * 1024;
const DAY = 86_400_000;

const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const KEY_RE = /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/;

export type CertCheck = { ok: true; info: OwnCertInfo; crt: string; key: string } | { ok: false; field: "cert" | "key"; message: string };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** "Let's Encrypt (R11)" from an X509 issuer block. */
export function issuerName(issuer: string): string | null {
  const get = (k: string) => issuer.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
  const o = get("O");
  const cn = get("CN");
  return o ? `${o}${cn ? ` (${cn})` : ""}` : (cn ?? null);
}

export function certNames(x: crypto.X509Certificate): string[] {
  const san = (x.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
  if (san.length) return san;
  const cn = x.subject.match(/^CN=(.+)$/m)?.[1];
  return cn ? [cn] : [];
}

/** What to show about a certificate that's already stored (no checks against a key). */
export function describeCert(x: crypto.X509Certificate, host: string, now = Date.now()): OwnCertInfo {
  const validTo = Date.parse(x.validTo);
  const daysLeft = Math.floor((validTo - now) / DAY);
  const selfSigned = x.checkIssued(x);
  const warnings: string[] = [];
  if (daysLeft < 0) warnings.push(`It expired on ${day(validTo)}. Browsers refuse it until you replace it.`);
  else if (daysLeft < OWN_CERT_WARN_DAYS) warnings.push(`It ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}, and Gluon can't renew a certificate you supply. Replace it before then.`);
  if (selfSigned) warnings.push("It's self-signed, so browsers and apps warn about it unless they're set up to trust it.");
  return {
    host,
    names: certNames(x),
    issuer: issuerName(x.issuer),
    validFrom: new Date(Date.parse(x.validFrom)).toISOString(),
    validTo: new Date(validTo).toISOString(),
    daysLeft,
    fingerprint: x.fingerprint256,
    selfSigned,
    warnings,
  };
}

function parseKey(text: string): { key: crypto.KeyObject; pem: string } | { error: string } {
  const m = text.match(KEY_RE);
  if (!m) {
    if (text.includes("-----BEGIN CERTIFICATE-----")) return { error: "This is a certificate, not a private key. The key starts with -----BEGIN PRIVATE KEY----- (privkey.pem for certbot)." };
    return { error: "That isn't a private key. Paste the text that starts with -----BEGIN PRIVATE KEY-----." };
  }
  if (m[1] === "ENCRYPTED PRIVATE KEY" || /Proc-Type:\s*4,ENCRYPTED/.test(m[0])) {
    return { error: "This key is locked with a passphrase, and the web server can't type it in. Export it without one, for example with openssl pkey, and paste that." };
  }
  try {
    return { key: crypto.createPrivateKey(m[0]), pem: m[0] };
  } catch {
    return { error: "The key couldn't be read. It may be cut short; paste the whole file again." };
  }
}

/**
 * Is this certificate (with its chain) and key usable for `host`? It must parse, cover the host,
 * match the key and be valid now. The certificate for the key goes first, whatever order it came in.
 */
export function checkOwnCert(certText: string, keyText: string, host: string, now = Date.now()): CertCheck {
  const fail = (field: "cert" | "key", message: string): CertCheck => ({ ok: false, field, message });
  if (!certText.trim()) return fail("cert", "Paste the certificate, or choose its file.");
  if (!keyText.trim()) return fail("key", "Paste the private key, or choose its file.");
  if (certText.length > MAX_PEM) return fail("cert", "That's far too long for a certificate. Paste only the certificate and its chain.");
  if (keyText.length > MAX_PEM) return fail("key", "That's far too long for a private key.");

  const blocks = certText.match(CERT_RE) ?? [];
  if (!blocks.length) {
    if (/PRIVATE KEY-----/.test(certText)) return fail("cert", "This is a private key. It goes in the key box; the certificate starts with -----BEGIN CERTIFICATE-----.");
    return fail("cert", "That isn't a certificate. Paste the text that starts with -----BEGIN CERTIFICATE----- (fullchain.pem for certbot).");
  }
  const certs: crypto.X509Certificate[] = [];
  for (const b of blocks) {
    try {
      certs.push(new crypto.X509Certificate(b));
    } catch {
      return fail("cert", "Part of the certificate couldn't be read. It may be cut short; paste the whole file again.");
    }
  }
  const k = parseKey(keyText);
  if ("error" in k) return fail("key", k.error);

  const leafAt = certs.findIndex((x) => x.checkPrivateKey(k.key));
  if (leafAt < 0) return fail("key", "This key doesn't belong to the certificate. Use the key that was made with it (privkey.pem next to certbot's fullchain.pem).");
  const leaf = certs[leafAt]!;
  if (leaf.checkHost(host) === undefined) {
    const names = certNames(leaf);
    return fail("cert", `This certificate is for ${names.slice(0, 3).join(", ") || "another name"}${names.length > 3 ? ` and ${names.length - 3} more` : ""}, not ${host}.`);
  }
  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (to <= now) return fail("cert", `This certificate expired on ${day(to)}. Get a renewed one, then paste that.`);
  if (from > now) return fail("cert", `This certificate only becomes valid on ${day(from)}.`);

  const ordered = [blocks[leafAt]!, ...blocks.filter((_, i) => i !== leafAt)];
  const info = describeCert(leaf, host, now);
  if (ordered.length === 1 && !info.selfSigned) {
    info.warnings.push("Only the certificate itself is here, without the ones that vouch for it. Some apps refuse that; the full chain (fullchain.pem) is safer.");
  }
  return { ok: true, info, crt: ordered.join("\n") + "\n", key: k.pem + "\n" };
}
