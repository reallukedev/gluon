import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { findById } from "@/server/auth/users";
import { beginEnrolment, checkCode, checkEnrolTicket, disableTotp, enableTotp, generateRecoveryCodes, recoveryCodesLeft } from "@/server/auth/totp";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { decrypt } from "@/server/crypto";
import { audit } from "@/server/audit";
import { getSetting } from "@/server/settings";

/** Two-step status for Settings → Security. */
export const GET = route({ auth: "user" }, ({ user, zone }) => {
  const row = findById(user.id)!;
  return {
    enabled: !!row.totp_enabled,
    recoveryLeft: row.totp_enabled ? recoveryCodesLeft(row) : 0,
    requiredAway: user.role === "admin" && getSetting("requireMfaAway"),
    zone,
  };
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), secret: z.string().min(16).max(64), ticket: z.string().min(10).max(200), code: z.string().trim().min(6).max(8) }),
  z.object({ action: z.literal("disable") }),
  z.object({ action: z.literal("regenerate") }),
]);

/**
 * Every change here needs a fresh "confirm it's you": otherwise a stolen session could link the
 * thief's phone (locking the owner out) or switch two-step off.
 */
export const POST = route({ auth: "user", body, recent: true }, async ({ user, body, ip, zone }) => {
  const row = findById(user.id)!;
  switch (body.action) {
    case "begin": {
      const e = await beginEnrolment(row);
      return { secret: e.secret, qrSvg: e.qrSvg, uri: e.uri, ticket: e.ticket };
    }
    case "confirm": {
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
      enableTotp(user.id, body.secret, step, codes.hashes);
      audit(user, { action: row.totp_enabled ? "auth.mfa_replaced" : "auth.mfa_enabled", summary: row.totp_enabled ? "Moved two-step verification to a new authenticator" : "Turned on two-step verification" }, { ip, zone });
      return { recoveryCodes: codes.plain };
    }
    case "regenerate": {
      if (!row.totp_enabled || !row.totp_secret_enc) throw new AppError("mfa_off", "Two-step verification isn't on.", 400);
      const codes = generateRecoveryCodes();
      enableTotp(user.id, decrypt(row.totp_secret_enc), row.totp_last_step ?? 0, codes.hashes);
      audit(user, { action: "auth.recovery_regenerated", summary: "Made new recovery codes" }, { ip, zone });
      return { recoveryCodes: codes.plain };
    }
    case "disable": {
      if (!row.totp_enabled) return { ok: true };
      if (user.role === "admin" && getSetting("requireMfaAway") && zone === "away") {
        throw new AppError("mfa_required_away", "Admins can't turn off two-step sign-in from outside home. Do it from your home network.", 403);
      }
      disableTotp(user.id);
      audit(user, { action: "auth.mfa_disabled", summary: "Turned off two-step verification" }, { ip, zone });
      return { ok: true };
    }
  }
});
