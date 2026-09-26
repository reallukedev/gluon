import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { findById, verifyPassword } from "@/server/auth/users";
import { verifySecondFactor } from "@/server/auth/totp";
import { markRecentAuth } from "@/server/auth/session";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { audit } from "@/server/audit";

const body = z.object({ password: z.string().min(1, "Enter your password.").max(256), code: z.string().trim().max(20).optional() });

/** "Confirm it's you" before risky actions: password, plus a two-step code when that's on. */
export const POST = route({ auth: "user", body }, async ({ body, user, session, ip, zone }) => {
  const subject = `reauth:${user.username}`;
  guard(subject, ip, zone);
  if (!(await verifyPassword(findById(user.id), body.password))) {
    recordAttempt(subject, ip, false, zone);
    audit(user, { action: "auth.reauth", summary: "Wrong password when confirming it's them", outcome: "failed" }, { ip, zone });
    throw new AppError("bad_credentials", "That password isn't right.", 400, { field: "password" });
  }
  // Read again after the (slow) password check so the code is checked against the latest state.
  const row = findById(user.id);
  if (row?.totp_enabled) {
    if (!body.code) throw new AppError("code_required", "Enter the code from your authenticator app.", 400, { field: "code" });
    if (!verifySecondFactor(row.id, body.code).ok) {
      recordAttempt(subject, ip, false, zone);
      throw new AppError("bad_code", "That code didn't work. Use the one showing now.", 400, { field: "code" });
    }
  }
  recordAttempt(subject, ip, true, zone);
  markRecentAuth(session.idHash);
  return { ok: true };
});
