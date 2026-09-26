import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

type G = typeof globalThis & { __gluonKey?: Buffer };
const g = globalThis as G;

/** 32-byte key used to encrypt secrets at rest (integration tokens, channel credentials, TOTP secrets). */
function key(): Buffer {
  if (g.__gluonKey) return g.__gluonKey;
  const file = path.join(DATA_DIR, "secret.key");
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  let k: Buffer;
  try {
    k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (k.length !== 32) throw new Error("bad key length");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString("base64"), { mode: 0o600, flag: "wx" });
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

/** HMAC-SHA256 keyed with the server's secret key, domain-separated by `purpose`. */
export function hmac(purpose: string, value: string): string {
  return crypto.createHmac("sha256", key()).update(`${purpose}\0${value}`).digest("hex");
}
