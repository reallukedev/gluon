import "server-only";
import { getSetting } from "../settings";
import type { Zone } from "../net-zone";

/**
 * Sign-in rules an admin can set in Settings → Server: who needs two-step sign-in and where, and
 * what a password must look like.
 */

export type MfaPolicy = "off" | "admins-away" | "admins" | "everyone-away" | "everyone";

export function mfaPolicy(): MfaPolicy {
  return getSetting("mfaPolicy") ?? (getSetting("requireMfaAway") ? "admins-away" : "off");
}

/** Whether someone with this role, signing in from this zone, must use two-step sign-in. */
export function mfaRequired(role: "admin" | "member", zone: Zone, policy: MfaPolicy = mfaPolicy()): boolean {
  switch (policy) {
    case "off":
      return false;
    case "admins-away":
      return role === "admin" && zone === "away";
    case "admins":
      return role === "admin";
    case "everyone-away":
      return zone === "away";
    case "everyone":
      return true;
  }
}

/** Away-only rules leave a way to set it up: sign in at home. "Always" rules set it up straight after sign-in. */
export function mfaAlways(policy: MfaPolicy = mfaPolicy()): boolean {
  return policy === "admins" || policy === "everyone";
}

/** The sentence for whoever is stopped by the rule, so it says what to do next. */
export function mfaRequiredMessage(role: "admin" | "member", policy: MfaPolicy = mfaPolicy()): string {
  const who = role === "admin" && (policy === "admins" || policy === "admins-away") ? "Admins" : "Everyone";
  return mfaAlways(policy)
    ? `${who} on this server need two-step sign-in. Set it up to continue.`
    : `${who} need two-step sign-in to use Gluon from outside home. Turn it on in Settings → Security, or come back on your home network.`;
}

export interface PasswordPolicy {
  minLength: number;
  notUsername: boolean;
  lettersAndNumbers: boolean;
}

export function passwordPolicy(): PasswordPolicy {
  return getSetting("passwordPolicy");
}

/** What's wrong with a new password under these rules, or null. Plain sentences for the field. */
export function passwordProblem(pw: string, username: string | undefined, policy: PasswordPolicy): string | null {
  if (!pw) return "Enter a password.";
  if (pw.length > 256) return "That password is too long.";
  if (pw.length < policy.minLength) return `Use at least ${policy.minLength} characters.`;
  if (policy.notUsername && username && pw.trim().toLowerCase() === username.toLowerCase()) return "Use something other than your username.";
  if (policy.lettersAndNumbers && !(/\p{L}/u.test(pw) && /\p{N}/u.test(pw))) return "Use both letters and numbers.";
  return null;
}
