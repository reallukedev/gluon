import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { completeMfa, currentDevice } from "@/server/auth/session";
import { findById } from "@/server/auth/users";
import { beginEnrolment, checkCode, checkEnrolTicket, enableTotp, generateRecoveryCodes } from "@/server/auth/totp";
import { noteSignIn } from "@/server/auth/devices";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { audit } from "@/server/audit";
import { now, run } from "@/server/db";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), secret: z.string().min(16).max(64), ticket: z.string().min(10).max(200), code: z.string().trim().min(6).max(8) }),
]);

/**
 * Set up two-step sign-in before the first session starts. Used when an admin accepts an invite from
 * outside home: the invite link plus a password isn't enough to run the server from the internet, so
 * the account is created and then held here until an authenticator app is linked.
 */
export const POST = route({ auth: "public", body, burst: { limit: 20, windowMs: 60_000 } }, async ({ body, session, ip, zone, req }) => {
  if (!session || session.pending !== "enrol") throw new AppError("no_pending", "This step timed out. Sign in again from the start.", 410);
  const row = findById(session.userId);
  if (!row) throw new AppError("no_pending", "This step timed out. Sign in again from the start.", 410);
  if (row.totp_enabled) throw new AppError("mfa_on", "Two-step sign-in is already on for this account. Sign in normally.", 409);

  if (body.action === "begin") {
    const e = await beginEnrolment(row);
    return { secret: e.secret, qrSvg: e.qrSvg, uri: e.uri, ticket: e.ticket, username: row.username };
  }

  const subject = `enrol:${row.username}`;
  guard(subject, ip, zone);
  if (!checkEnrolTicket(row.id, body.secret, body.ticket)) {
    throw new AppError("enrol_expired", "This setup code expired. Start again to get a fresh one.", 400);
  }
  const step = checkCode(body.secret, body.code, null, row.username);
  if (step === null) {
    recordAttempt(subject, ip, false, zone);
    throw new AppError("bad_code", "That code didn't match. Check your phone's clock is set automatically, then try the code showing now.", 400, { field: "code" });
  }
  recordAttempt(subject, ip, true, zone);
  const codes = generateRecoveryCodes();
  enableTotp(row.id, body.secret, step, codes.hashes);
  const idHash = await completeMfa(session.idHash);
  run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), row.id);
  audit({ id: row.id, username: row.username }, { action: "auth.mfa_enabled", summary: "Turned on two-step verification while joining" }, { ip, zone });
  noteSignIn(row, idHash, await currentDevice(), { ip, zone, userAgent: req.headers.get("user-agent") });
  return { recoveryCodes: codes.plain };
});
