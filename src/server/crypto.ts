import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

type G = typeof globalThis & { __gluonKey?: Buffer };
const g = globalThis as G;

const DEFAULT_KEY_FILE = () => path.join(DATA_DIR, "secret.key");

function readKey(file: string): Buffer | null {
  try {
    const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (k.length !== 32) throw new Error(`${file} isn't a Gluon secret key (wrong length)`);
    return k;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Written whole or not at all, and never over an existing key. */
function writeKey(file: string, k: Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, k.toString("base64"), { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The key that seals every stored secret. It lives next to the database unless GLUON_SECRET_KEY_FILE
 * points somewhere else (another volume, a Docker secret), so a backup of the data volume alone can't
 * open what's in it. Pointing it elsewhere moves an existing key there on the next start.
 */
function key(): Buffer {
  if (g.__gluonKey) return g.__gluonKey;
  const legacy = DEFAULT_KEY_FILE();
  const file = process.env.GLUON_SECRET_KEY_FILE?.trim() || legacy;
  let k = readKey(file);
  if (!k && file !== legacy) {
    const old = readKey(legacy);
    if (old) {
      writeKey(file, old);
      if (!readKey(file)?.equals(old)) throw new Error(`Couldn't move Gluon's secret key to ${file}`);
      fs.rmSync(legacy, { force: true });
      console.log(`[gluon] moved the secret key to ${file}`);
      k = old;
    }
  }
  if (!k) {
    k = crypto.randomBytes(32);
    try {
      writeKey(file, k);
    } catch (e) {
      // Another process made one first: use theirs.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      k = readKey(file)!;
    }
  } else if (file !== legacy && fs.existsSync(legacy)) {
    // A data volume restored from an older backup brings the old copy back; it's the same key.
    if (readKey(legacy)?.equals(k)) fs.rmSync(legacy, { force: true });
  }
  g.__gluonKey = k;
  return k;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unrecognised secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

export const encryptJson = (v: unknown) => encrypt(JSON.stringify(v));
export const decryptJson = <T>(s: string): T => JSON.parse(decrypt(s)) as T;

export const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const id = (bytes = 9) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Domain-separated by `purpose`. */
export function hmac(purpose: string, value: string): string {
  return crypto.createHmac("sha256", key()).update(`${purpose}\0${value}`).digest("hex");
}
