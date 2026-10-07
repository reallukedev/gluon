import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { acceptInvite, peekInvite } from "@/server/auth/invites";
import { createSession, currentDevice } from "@/server/auth/session";
import { noteSignIn } from "@/server/auth/devices";
import { findById } from "@/server/auth/users";
import { audit } from "@/server/audit";
import { getSetting } from "@/server/settings";
import { mfaRequired } from "@/server/auth/policy";

const tokenOk = (t: unknown): t is string => typeof t === "string" && t.length >= 16 && t.length <= 100;

export const GET = route({ auth: "public", burst: { limit: 30, windowMs: 60_000 } }, async ({ params }) => {
  const row = tokenOk(params.token) ? peekInvite(params.token) : null;
  if (!row) return { valid: false, serverName: getSetting("serverName") };
  return { valid: true, role: row.role, displayName: row.display_name, serverName: getSetting("serverName") };
});

const body = z.object({
  username: z.string().trim().min(2, "Usernames are at least 2 characters.").max(32),
  displayName: z.string().trim().max(60).default(""),
  password: z.string().min(1, "Choose a password.").max(256),
});

/**
 * Accept an invite: creates the account and signs in. An admin joining from outside home (with the
 * away rule on) is signed in only after linking an authenticator app: `{ next: "enrol" }`.
 */
export const POST = route({ auth: "public", body, burst: { limit: 10, windowMs: 60_000 } }, async ({ params, body, ip, zone, req }) => {
  if (!tokenOk(params.token)) throw new AppError("invite_invalid", "This invite link isn't valid.", 400);
  const user = await acceptInvite(params.token, body);
  const mustEnrol = mfaRequired(user.role, zone);
  const idHash = await createSession(user.id, { pending: mustEnrol ? "enrol" : "none" });
  audit(user, { action: "auth.invite_accepted", summary: `Joined as ${user.role === "admin" ? "an admin" : "a household member"}` }, { ip, zone });
  if (!mustEnrol) {
    const row = findById(user.id);
    if (row) noteSignIn(row, idHash, await currentDevice(), { ip, zone, userAgent: req.headers.get("user-agent") });
  }
  return { next: mustEnrol ? "enrol" : "done" };
});
