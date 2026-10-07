import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { findById, setPassword, verifyPassword } from "@/server/auth/users";
import { hasRecentAuth, markRecentAuth, revokeOtherSessions } from "@/server/auth/session";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { audit } from "@/server/audit";
import { run } from "@/server/db";

const body = z.object({
  current: z.string().min(1, "Enter your current password.").max(256),
  next: z.string().min(1, "Choose a new password.").max(256),
  signOutOthers: z.boolean().default(true),
});

/** When the password was last changed (for Settings → Security). */
export const GET = route({ auth: "user" }, ({ user }) => ({ changedAt: findById(user.id)?.password_changed_at ?? null }));

/** Change your own password. Needs the current one (throttled like sign-in). */
export const POST = route({ auth: "user", body }, async ({ user, session, body, ip, zone }) => {
  // With two-step on, a password alone isn't enough to change the password: someone holding the
  // cookie and the old password, but not the phone, could otherwise lock the owner out.
  if (user.mfa && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  // One budget per person across sign-in, re-auth and password change.
  const subject = `login:${user.username}`;
  guard(subject, ip, zone);
  if (!(await verifyPassword(findById(user.id), body.current))) {
    recordAttempt(subject, ip, false, zone);
    audit(user, { action: "auth.password_changed", summary: "Wrong current password when changing it", outcome: "failed" }, { ip, zone });
    throw new AppError("bad_credentials", "Your current password isn't right.", 400, { field: "current" });
  }
  if (body.next === body.current) {
    throw new AppError("same_password", "That's the password you have now. Choose a different one.", 400, { field: "next" });
  }
  recordAttempt(subject, ip, true, zone);
  await setPassword(user.id, body.next);
  run("UPDATE users SET must_change_password = 0 WHERE id = ?", user.id);
  const signedOut = body.signOutOthers ? revokeOtherSessions(user.id, session.idHash) : 0;
  // Counts as confirming it's you only when the password is the whole sign-in.
  if (!user.mfa) markRecentAuth(session.idHash);
  audit(user, { action: "auth.password_changed", summary: signedOut ? `Changed their password and signed out ${signedOut} other device${signedOut === 1 ? "" : "s"}` : "Changed their password" }, { ip, zone });
  return { ok: true, signedOut };
});
