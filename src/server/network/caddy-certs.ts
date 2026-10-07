import "server-only";
import os from "node:os";
import { docker } from "../docker/client";
import { CADDY_DIR, httpsMode, setCaddyMount, tryReadConfig, DEFAULT_CADDY_MOUNT } from "../caddy/routes";
import { readTar, type TarEntry } from "./tarball";
import { pickCaddyPair } from "./xmpp-cert-choice";
import { readOwnCert } from "./own-certs";

/**
 * Caddy's side of certificates: where its container sees Gluon's Caddy folder, which user it runs
 * as (so keys Gluon writes are readable to it), and the certificate it serves for a name.
 */

export const CADDY_CONTAINER = (process.env.GLUON_CADDY_CONTAINER ?? process.env.TEND_CADDY_CONTAINER) ?? "caddy";
const CADDY_CERTS = "/data/caddy/certificates";

/** Files under `path` in a container, or null when the path (or container) doesn't exist. */
export async function readArchive(container: string, path: string): Promise<TarEntry[] | null> {
  try {
    const stream = (await docker().getContainer(container).getArchive({ path })) as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return readTar(Buffer.concat(chunks));
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) return null;
    throw e;
  }
}

/** Caddy's whole certificate store, read once per caller. */
export const readCaddyStore = () => readArchive(CADDY_CONTAINER, CADDY_CERTS);

interface CaddySide {
  mount: string;
  /** Numeric uid Caddy runs as when it isn't root (null: root, or a name Gluon can't map). */
  uid: number | null;
}
let side: { at: number; value: CaddySide } | null = null;

/**
 * Where Caddy's container mounts the folder Gluon writes the Caddyfile to: the Caddy mount whose
 * host folder is the one Gluon has at CADDY_DIR. Falls back to /etc/caddy, the usual place.
 */
export async function caddySide(maxAgeMs = 10 * 60_000): Promise<CaddySide> {
  if (side && Date.now() - side.at < maxAgeMs) return side.value;
  const value: CaddySide = { mount: DEFAULT_CADDY_MOUNT, uid: null };
  try {
    const caddy = await docker().getContainer(CADDY_CONTAINER).inspect();
    const user = (caddy.Config.User ?? "").split(":")[0] ?? "";
    if (/^\d+$/.test(user) && user !== "0") value.uid = Number(user);
    let source: string | null = null;
    try {
      const self = await docker().getContainer(os.hostname()).inspect();
      source = self.Mounts.find((m) => m.Destination === CADDY_DIR)?.Source ?? null;
    } catch {
      /* Gluon isn't in a container (development) */
    }
    const mine = caddy.Mounts.find((m) => (source ? m.Source === source : false)) ?? caddy.Mounts.find((m) => m.Destination === DEFAULT_CADDY_MOUNT);
    if (mine) value.mount = mine.Destination.replace(/\/+$/, "");
  } catch {
    /* no Caddy container: keep the default */
  }
  setCaddyMount(value.mount);
  side = { at: Date.now(), value };
  return value;
}

export interface CaddyCertificate {
  crt: Buffer;
  key: Buffer;
  notAfter: number;
  fingerprint: string;
}

/**
 * The certificate and key web visitors get for `host`: the person's own when the address uses one,
 * otherwise the longest-lasting trusted one in Caddy's store. Null when there isn't one (yet), or
 * when the address is plain HTTP or has no web side, so Caddy holds none.
 */
export async function caddyCertificateFor(host: string): Promise<CaddyCertificate | null> {
  const h = host.toLowerCase();
  const route = tryReadConfig()?.routes.find((r) => r.type === "subdomain" && r.host === h);
  const mode = httpsMode(route);
  if (mode === "http" || mode === "none") return null;
  if (mode === "own") {
    const own = readOwnCert(h);
    return own ? { crt: own.crt, key: own.key, notAfter: own.info.notAfter, fingerprint: own.info.fingerprint } : null;
  }
  const store = await readCaddyStore();
  const pair = store ? pickCaddyPair(store, h) : null;
  return pair ? { crt: pair.crt, key: pair.key, notAfter: pair.info.notAfter, fingerprint: pair.info.fingerprint } : null;
}
