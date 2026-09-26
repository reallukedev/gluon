import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { createUser, userCount } from "@/server/auth/users";
import { checkSetupCode, clearSetupCode } from "@/server/auth/setup";
import { createSession, currentDevice } from "@/server/auth/session";
import { noteSignIn } from "@/server/auth/devices";
import { audit } from "@/server/audit";
import { setSetting } from "@/server/settings";
import { findById } from "@/server/auth/users";
import { guard, recordAttempt } from "@/server/auth/ratelimit";

const body = z.object({
  code: z.string().trim().min(4, "Enter the setup code.").max(40),
  username: z.string().trim().min(2, "Usernames are at least 2 characters.").max(32),
  displayName: z.string().trim().max(60).default(""),
  password: z.string().min(1, "Choose a password.").max(256),
});

type G = typeof globalThis & { __gluonSetupBusy?: boolean };
const g = globalThis as G;

/**
 * Create the first admin. Only while no account exists at all, only from the home network, and only
 * with the one-time code from the server log. One request at a time, so two browsers racing can't
 * both become the first admin.
 */
export const POST = route({ auth: "public", body, burst: { limit: 10, windowMs: 60_000 } }, async ({ body, ip, zone, req }) => {
  if (userCount() > 0) throw new AppError("already_setup", "Gluon is already set up. Sign in instead.", 409);
  if (zone !== "home") {
    throw new AppError("setup_home_only", "Gluon can only be set up from your home network. Open it on a device at home to finish.", 403);
  }
  guard("setup", ip, zone);
  if (!checkSetupCode(body.code)) {
    recordAttempt("setup", ip, false, zone);
    throw new AppError("bad_code", "That setup code doesn't match. Copy it again from the server log.", 400, { field: "code" });
  }
  if (g.__gluonSetupBusy) throw new AppError("busy", "Setup is already in progress in another window.", 409);
  g.__gluonSetupBusy = true;
  try {
    if (userCount() > 0) throw new AppError("already_setup", "Gluon is already set up. Sign in instead.", 409);
    const user = await createUser({ username: body.username, displayName: body.displayName || body.username, role: "admin", password: body.password });
    clearSetupCode();
    setSetting("setupDone", true);
    recordAttempt("setup", ip, true, zone);
    const idHash = await createSession(user.id, { pending: "none" });
    audit(user, { action: "auth.setup", summary: "Set up Gluon and created the first admin account" }, { ip, zone });
    const row = findById(user.id);
    if (row) noteSignIn(row, idHash, await currentDevice(), { ip, zone, userAgent: req.headers.get("user-agent") });
    return { ok: true };
  } finally {
    g.__gluonSetupBusy = false;
  }
});
