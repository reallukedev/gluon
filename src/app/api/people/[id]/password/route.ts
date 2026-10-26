import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { describePerson, resetPassword } from "@/server/people/users";

/** Set a temporary password (signs them out everywhere). */
const body = z.object({
  password: z.string().min(1, "Enter a temporary password.").max(256),
  /** Ask them to choose their own at next sign-in. */
  mustChange: z.boolean().default(true),
});

export const POST = route({ auth: "admin", body, recent: true }, async ({ user, params, body, ip, zone }) => {
  const row = await resetPassword(user, String(params.id), body.password, body.mustChange);
  audit(user, { action: "people.password_reset", target: row.id, summary: `Set a temporary password for ${describePerson(row)}` }, { ip, zone });
  return { ok: true };
});
