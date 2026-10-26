import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { completeMfa, currentDevice, destroyCurrentSession } from "@/server/auth/session";
import { findById } from "@/server/auth/users";
import { verifySecondFactor } from "@/server/auth/totp";
import { noteSignIn } from "@/server/auth/devices";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { audit } from "@/server/audit";
import { now, run } from "@/server/db";

const body = z.object({ code: z.string().trim().min(6, "Enter the 6-digit code.").max(20) });

/** Wrong codes allowed on one pending sign-in before it has to start over from the password. */
const MAX_TRIES_PER_SIGNIN = 5;
const tries = new Map<string, number>();

/** Second step of signing in: a code from the authenticator app, or a recovery code. */
export const POST = route({ auth: "public", body, burst: { limit: 20, windowMs: 60_000 } }, async ({ body, session, ip, zone, req }) => {
  // 410, not 401: the client treats 401 as "go to the sign-in page", and we're already on it.
  if (!session || session.pending !== "code") throw new AppError("no_pending", "Your sign-in timed out. Enter your password again.", 410);
  const row = findById(session.userId);
  if (!row) throw new AppError("no_pending", "Your sign-in timed out. Enter your password again.", 410);
  const subject = `mfa:${row.username}`;
  guard(subject, ip, zone);
  const r = verifySecondFactor(row.id, body.code);
  if (!r.ok) {
    recordAttempt(subject, ip, false, zone);
    const n = (tries.get(session.idHash) ?? 0) + 1;
    if (tries.size > 1000) tries.clear();
    tries.set(session.idHash, n);
    audit({ id: row.id, username: row.username }, { action: "auth.login", summary: "Wrong two-step code", outcome: "failed" }, { ip, zone });
    if (n >= MAX_TRIES_PER_SIGNIN) {
      tries.delete(session.idHash);
      await destroyCurrentSession();
      throw new AppError("no_pending", "Too many wrong codes. Enter your password again to get a fresh try.", 410);
    }
    throw new AppError("bad_code", "That code didn't work. Codes change every 30 seconds, so use the one showing now.", 400, { field: "code" });
  }
  tries.delete(session.idHash);
  recordAttempt(subject, ip, true, zone);
  const idHash = await completeMfa(session.idHash);
  run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), row.id);
  audit({ id: row.id, username: row.username }, { action: "auth.login", summary: r.usedRecovery ? "Signed in with a recovery code" : "Signed in with two-step verification" }, { ip, zone });
  noteSignIn(row, idHash, await currentDevice(), { ip, zone, userAgent: req.headers.get("user-agent") });
  return { ok: true, usedRecovery: !!r.usedRecovery, remainingRecovery: r.remainingRecovery ?? null };
});
