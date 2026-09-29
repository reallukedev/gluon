import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { findByUsername, verifyPassword, type UserRow } from "@/server/auth/users";
import { guard, recordAttempt } from "@/server/auth/ratelimit";
import { createSession, currentDevice } from "@/server/auth/session";
import { noteSignIn } from "@/server/auth/devices";
import { audit } from "@/server/audit";
import { raise, resolve } from "@/server/findings";
import { getSetting } from "@/server/settings";
import { peopleHref } from "@/lib/settings-links";
import { now, run } from "@/server/db";
import type { Zone } from "@/server/net-zone";

const body = z.object({ username: z.string().trim().min(1, "Enter your username.").max(64), password: z.string().min(1, "Enter your password.").max(256) });

const WRONG = "Wrong username or password.";

/** An admin hears about it (once per episode) when someone keeps guessing a real account's password. */
function noteThrottle(row: UserRow, failures: number, ip: string, zone: Zone) {
  raise({
    id: `signin.throttled:${row.id}`,
    kind: "signin.throttled",
    severity: "attention",
    subject: row.id,
    title: `Sign-ins to ${row.display_name || row.username}'s account are being slowed down`,
    cause: `${failures} wrong passwords in a row, most recently from ${ip} (${zone === "home" ? "at home" : "outside home"}). Gluon now waits longer between each try. If it wasn't them, their password may be being guessed.`,
    detail: { userId: row.id, ip, zone, failures },
    remedy: { action: "", label: "Review the account", href: peopleHref({ person: row.id }) },
  });
}

/**
 * Password step. Answers `{ next: "done" }`, or `{ next: "mfa" }` when a second step follows.
 * Unknown usernames, wrong passwords and disabled accounts all get the same answer, after the same
 * amount of work.
 */
export const POST = route({ auth: "public", body, burst: { limit: 20, windowMs: 60_000 } }, async ({ body, ip, zone, req }) => {
  const username = body.username;
  guard(`login:${username}`, ip, zone);
  const row = findByUsername(username);
  const ok = await verifyPassword(row, body.password);
  const usable = !!row && !row.disabled;

  // An admin without two-step, from outside home: a password alone is never enough here. Say so
  // whether or not the password was right, so this answer can't be used to confirm a guess.
  if (usable && zone === "away" && row.role === "admin" && !row.totp_enabled && getSetting("requireMfaAway")) {
    if (!ok) {
      const r = recordAttempt(`login:${username}`, ip, false, zone);
      if (r.startedThrottle) noteThrottle(row, r.failures, ip, zone);
    }
    audit({ id: row.id, username: row.username }, { action: "auth.login", summary: "Blocked admin sign-in from outside home without two-step verification", outcome: "failed" }, { ip, zone });
    throw new AppError(
      "mfa_required_away",
      "Admins need two-step sign-in to connect from outside home. Sign in once on your home network, turn it on in Settings → Security, then try again.",
      403,
    );
  }

  if (!ok || !usable) {
    const r = recordAttempt(`login:${username}`, ip, false, zone);
    if (usable && r.startedThrottle) noteThrottle(row, r.failures, ip, zone);
    audit(row ? { id: row.id, username: row.username } : null, { action: "auth.login", summary: `Failed sign-in for “${username.slice(0, 40)}”`, outcome: "failed" }, { ip, zone });
    throw new AppError("bad_credentials", WRONG, 400);
  }

  const needsMfa = !!row.totp_enabled;
  recordAttempt(`login:${username}`, ip, true, zone);
  resolve(`signin.throttled:${row.id}`, "Signed in successfully");
  const idHash = await createSession(row.id, { pending: needsMfa ? "code" : "none" });
  if (!needsMfa) {
    run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), row.id);
    audit({ id: row.id, username: row.username }, { action: "auth.login", summary: "Signed in" }, { ip, zone });
    noteSignIn(row, idHash, await currentDevice(), { ip, zone, userAgent: req.headers.get("user-agent") });
  }
  return { next: needsMfa ? "mfa" : "done" };
});
