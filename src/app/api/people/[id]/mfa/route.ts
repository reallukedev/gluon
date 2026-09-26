import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { describePerson, resetMfa } from "@/server/people/users";

/** Turn off someone's two-step verification (lost phone). They can set it up again after signing in. */
export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => {
  const row = resetMfa(user, String(params.id));
  audit(user, { action: "people.mfa_reset", target: row.id, summary: `Turned off two-step verification for ${describePerson(row)}` }, { ip, zone });
  return { ok: true };
});
