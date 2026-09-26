import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { cancelInvite, makeInvite, openInvites } from "@/server/people/users";

/** Unused, unexpired invites. */
export const GET = route({ auth: "admin" }, () => openInvites());

const post = z.object({ role: z.enum(["admin", "member"]).default("member"), displayName: z.string().trim().max(60).nullable().default(null) });

/** Returns the invite link once (only a hash is stored). Valid for 7 days, single use. */
export const POST = route({ auth: "admin", body: post, recent: true }, ({ user, body, ip, zone }) => {
  const inv = makeInvite(user, body.role, body.displayName);
  audit(user, { action: "people.invited", target: inv.id, summary: `Invited ${inv.displayName ?? "someone"} as ${inv.role === "admin" ? "an admin" : "a household member"}` }, { ip, zone });
  return inv;
});

const del = z.object({ id: z.string().min(8).max(64) });

export const DELETE = route({ auth: "admin", body: del, recent: true }, ({ user, body, ip, zone }) => {
  const inv = cancelInvite(body.id);
  audit(user, { action: "people.invite_revoked", target: inv.id, summary: `Cancelled the invite for ${inv.displayName ?? "someone"}` }, { ip, zone });
  return { ok: true };
});
