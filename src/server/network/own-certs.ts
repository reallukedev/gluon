import "server-only";
import fs from "node:fs";
import crypto from "node:crypto";
import { CADDY_DIR, CERTS_DIR, httpsMode, ownCertFiles, reloadCaddy, tryReadConfig, type RoutesConfig, type SubdomainRoute } from "../caddy/routes";
import { hostPath } from "../host/paths";
import { AppError } from "../errors";
import { audit } from "../audit";
import { certInfo, type CertInfo } from "./xmpp-cert-choice";
import { checkOwnCert, describeCert, type CertCheck } from "./own-cert-check";
import type { CertUploads, OwnCertInfo, OwnCertState } from "@/lib/network-types";

/**
 * Certificates people supply for their addresses. Caddy serves them from ./certs next to the
 * Caddyfile (its container sees the same folder read-only). Pasted ones are written once; ones that
 * live in files on the server (certbot's live folder) are copied again whenever they change.
 */

const MAX_FILE = 64 * 1024;

type OwnRoute = SubdomainRoute & { https: NonNullable<SubdomainRoute["https"]> };
const isOwn = (r: RoutesConfig["routes"][number]): r is OwnRoute => r.type === "subdomain" && httpsMode(r) === "own";

function readIf(p: string): Buffer | null {
  try {
    return fs.readFileSync(/*turbopackIgnore: true*/ p);
  } catch {
    return null;
  }
}

/** The stored certificate and key Caddy serves for `host`. */
export function readOwnCert(host: string): { crt: Buffer; key: Buffer; info: CertInfo } | null {
  const f = ownCertFiles(host);
  const crt = readIf(f.crt);
  const key = readIf(f.key);
  const info = crt ? certInfo(crt, host) : null;
  return crt && key && info ? { crt, key, info } : null;
}

export function storedCertInfo(host: string): OwnCertInfo | null {
  const text = readIf(ownCertFiles(host).crt)?.toString();
  const leaf = text?.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!leaf) return null;
  try {
    return describeCert(new crypto.X509Certificate(leaf), host);
  } catch {
    return null;
  }
}

function owner(): { uid: number; gid: number } | null {
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ CADDY_DIR);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

function writeFile(p: string, data: string | Buffer, mode: number, uid: number | null) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  const o = owner();
  try {
    if (o) fs.chownSync(tmp, uid ?? o.uid, o.gid);
  } catch {
    /* best effort: Caddy usually runs as root and reads it either way */
  }
  fs.renameSync(tmp, p);
}

/** Write a checked pair. The key is 0600, owned by the user Caddy runs as when that isn't root. */
function writeOwnCert(host: string, crt: string, key: string, keyUid: number | null) {
  fs.mkdirSync(CERTS_DIR, { recursive: true, mode: 0o755 });
  const f = ownCertFiles(host);
  writeFile(f.key, key, 0o600, keyUid);
  writeFile(f.crt, crt, 0o644, null);
}

/** Read and check a certificate and key from files on the server. Fields name the file at fault. */
export function readCertFiles(files: { cert: string; key: string }, host: string): CertCheck {
  const read = (p: string, field: "cert" | "key"): string | CertCheck => {
    try {
      const real = hostPath(p);
      if (fs.statSync(/*turbopackIgnore: true*/ real).size > MAX_FILE) return { ok: false, field, message: `${p} is too big to be a ${field === "cert" ? "certificate" : "key"}.` };
      return fs.readFileSync(/*turbopackIgnore: true*/ real, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ok: false, field, message: code === "ENOENT" ? `There's no file at ${p}.` : code === "EACCES" ? `Gluon isn't allowed to read ${p}.` : code === "EISDIR" ? `${p} is a folder. Enter the file inside it.` : `Gluon couldn't read ${p} (${code ?? "error"}).` };
    }
  };
  const cert = read(files.cert, "cert");
  if (typeof cert !== "string") return cert;
  const key = read(files.key, "key");
  if (typeof key !== "string") return key;
  return checkOwnCert(cert, key, host);
}

const FILE_FIELD = { cert: "cert_file", key: "key_file" } as const;

function certError(check: Extract<CertCheck, { ok: false }>, routeId: string, fromFiles: boolean): AppError {
  return new AppError("invalid_cert", check.message, 400, { route: routeId, field: fromFiles ? FILE_FIELD[check.field] : check.field });
}

/** Check a certificate before saving (from pasted text or files), without storing anything. */
export function previewCert(host: string, src: { cert: string; key: string } | { files: { cert: string; key: string } }): OwnCertInfo {
  const fromFiles = "files" in src;
  const check = fromFiles ? readCertFiles(src.files, host) : checkOwnCert(src.cert, src.key, host);
  if (!check.ok) throw new AppError("invalid_cert", check.message, 400, { field: fromFiles ? FILE_FIELD[check.field] : check.field });
  return check.info;
}

/**
 * Put every own certificate the next config needs in place before Caddy loads it: pasted ones
 * from this save, and file-based ones that are new or point somewhere new. Throws (with the field
 * at fault) when one is missing or doesn't check out. `rollback` restores what was there.
 */
export function stageOwnCerts(next: RoutesConfig, prev: RoutesConfig | null, uploads: CertUploads, keyUid: number | null): { changed: boolean; rollback: () => void } {
  const backups: { path: string; data: Buffer | null }[] = [];
  const before = new Map((prev?.routes ?? []).map((r) => [r.id, r]));
  const rollback = () => {
    for (const b of backups.reverse()) {
      try {
        if (b.data) fs.writeFileSync(b.path, b.data);
        else fs.rmSync(b.path, { force: true });
      } catch {
        /* best effort */
      }
    }
  };
  try {
    for (const r of next.routes.filter(isOwn)) {
      const p = before.get(r.id);
      const upload = uploads[r.host];
      let check: CertCheck | null = null;
      if (upload) {
        check = checkOwnCert(upload.cert, upload.key, r.host);
        if (!check.ok) throw certError(check, r.id, false);
      } else if (r.https.files) {
        const same = p && isOwn(p) && p.host === r.host && JSON.stringify(p.https.files) === JSON.stringify(r.https.files);
        if (!same || (r.enabled !== false && !readOwnCert(r.host))) {
          check = readCertFiles(r.https.files, r.host);
          if (!check.ok) throw certError(check, r.id, true);
        }
      } else if (r.enabled !== false && !readOwnCert(r.host)) {
        // Turned-off addresses aren't in the Caddyfile, so they don't need the file yet.
        throw new AppError("invalid_cert", `Add the certificate for ${r.host}: paste it, or point Gluon at its files.`, 400, { route: r.id, field: "https" });
      }
      if (!check?.ok) continue;
      const f = ownCertFiles(r.host);
      for (const path of [f.crt, f.key]) backups.push({ path, data: readIf(path) });
      writeOwnCert(r.host, check.crt, check.key, keyUid);
      if (r.https.files) fileState().set(r.id, { copiedAt: Date.now(), error: null });
    }
  } catch (e) {
    rollback();
    throw e;
  }
  return { changed: backups.length > 0, rollback };
}

// ---------------------------------------------------------------- certificates kept in files

type G = typeof globalThis & { __gluonOwnCertFiles?: Map<string, { copiedAt: number | null; error: string | null }> };
const fileState = () => ((globalThis as G).__gluonOwnCertFiles ??= new Map());

export function ownCertStates(cfg: RoutesConfig): Record<string, OwnCertState> {
  const out: Record<string, OwnCertState> = {};
  for (const r of cfg.routes.filter(isOwn)) {
    const s = fileState().get(r.id);
    out[r.id] = { stored: storedCertInfo(r.host), copiedAt: s?.copiedAt ?? null, error: r.https.files ? (s?.error ?? null) : null };
  }
  return out;
}

/**
 * Copy certificates kept in files (renewed by certbot or similar) when they change, then have Caddy
 * load them. A file that's missing or doesn't check out leaves the copy Caddy has in place.
 */
export async function syncOwnCertFiles(keyUid: number | null): Promise<void> {
  const cfg = tryReadConfig();
  if (!cfg) return;
  let changed = false;
  for (const r of cfg.routes.filter(isOwn)) {
    if (!r.https.files) continue;
    const prev = fileState().get(r.id);
    const check = readCertFiles(r.https.files, r.host);
    if (!check.ok) {
      fileState().set(r.id, { copiedAt: prev?.copiedAt ?? null, error: `${check.message} Caddy keeps serving the copy it has.` });
      continue;
    }
    if (readOwnCert(r.host)?.info.fingerprint === check.info.fingerprint) {
      fileState().set(r.id, { copiedAt: prev?.copiedAt ?? null, error: null });
      continue;
    }
    writeOwnCert(r.host, check.crt, check.key, keyUid);
    fileState().set(r.id, { copiedAt: Date.now(), error: null });
    changed = true;
    audit(null, {
      action: "network.cert.copy",
      target: r.host,
      summary: `Copied the renewed certificate for ${r.host} from ${r.https.files.cert}`,
      detail: { validUntil: check.info.validTo.slice(0, 10), fingerprint: check.info.fingerprint },
      outcome: "ok",
    });
  }
  if (changed) await reloadCaddy();
}
