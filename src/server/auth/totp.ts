import "server-only";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import crypto from "node:crypto";
import { decrypt, encrypt, hmac, safeEqual } from "../crypto";
import { now, run } from "../db";
import { getSetting } from "../settings";
import { findById, recoveryHash, recoveryHashes, type UserRow } from "./users";

const PERIOD = 30;

function totpFor(secretB32: string, label: string) {
  return new OTPAuth.TOTP({
    issuer: `Gluon (${getSetting("serverName")})`,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secretB32),
  });
}

const ENROL_TTL_MS = 20 * 60_000;
const enrolTicket = (userId: string, secret: string, expires: number) => `${expires}.${hmac("totp-enrol", `${userId}\0${secret}\0${expires}`)}`;

/**
 * Start enrolment: a fresh secret (not saved until confirmed) + QR code for authenticator apps.
 * The secret travels through the browser, so it comes with a signed ticket: confirming only accepts
 * a secret this server generated for this person in the last 20 minutes.
 */
export async function beginEnrolment(user: Pick<UserRow, "id" | "username">) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = totpFor(secret.base32, user.username);
  const uri = totp.toString();
  const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#0000" } });
  const ticket = enrolTicket(user.id, secret.base32, now() + ENROL_TTL_MS);
  return { secret: secret.base32, uri, qrSvg, ticket };
}

export function checkEnrolTicket(userId: string, secret: string, ticket: string): boolean {
  const [exp] = ticket.split(".");
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < now()) return false;
  return safeEqual(enrolTicket(userId, secret, expires), ticket);
}

/** Verify a 6-digit code against a secret, allowing ±1 step, rejecting replays. Returns the matched step. */
export function checkCode(secretB32: string, code: string, lastStep: number | null, label = "user"): number | null {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  const delta = totpFor(secretB32, label).validate({ token: cleaned, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(Date.now() / 1000 / PERIOD) + delta;
  if (lastStep !== null && step <= lastStep) return null; // replay
  return step;
}

export function generateRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: 10 }, () => {
    const b = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    return `${b.slice(0, 5)}-${b.slice(5)}`;
  });
  return { plain, hashes: plain.map(recoveryHash) };
}

export function enableTotp(userId: string, secretB32: string, step: number, codeHashes: string[]) {
  run(
    "UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_step = ?, recovery_codes = ?, updated_at = ? WHERE id = ?",
    encrypt(secretB32),
    step,
    JSON.stringify(codeHashes),
    now(),
    userId,
  );
}

export function disableTotp(userId: string) {
  run("UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?", now(), userId);
}

/**
 * Verify a second factor: a TOTP code or a single-use recovery code. Reads the account fresh so two
 * concurrent requests can't both spend the same code.
 */
export function verifySecondFactor(userId: string, input: string): { ok: boolean; usedRecovery?: boolean; remainingRecovery?: number } {
  const user = findById(userId);
  if (!user || !user.totp_enabled || !user.totp_secret_enc) return { ok: false };
  const secret = decrypt(user.totp_secret_enc);
  const step = checkCode(secret, input, user.totp_last_step, user.username);
  if (step !== null) {
    run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, user.id);
    return { ok: true };
  }
  if (/^[a-f0-9]{5}[\s-]?[a-f0-9]{5}$/i.test(input.trim())) {
    const hashes: string[] = JSON.parse(user.recovery_codes ?? "[]");
    const candidates = recoveryHashes(input.trim());
    const idx = hashes.findIndex((h) => candidates.includes(h));
    if (idx >= 0) {
      hashes.splice(idx, 1);
      run("UPDATE users SET recovery_codes = ? WHERE id = ?", JSON.stringify(hashes), user.id);
      return { ok: true, usedRecovery: true, remainingRecovery: hashes.length };
    }
  }
  return { ok: false };
}

export function recoveryCodesLeft(user: Pick<UserRow, "recovery_codes">): number {
  try {
    return (JSON.parse(user.recovery_codes ?? "[]") as string[]).length;
  } catch {
    return 0;
  }
}

