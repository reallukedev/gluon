import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { describePerson, personOrThrow, revokeSessionsOf, sessionsOf } from "@/server/people/users";

export const GET = route({ auth: "admin" }, ({ params, session }) => sessionsOf(String(params.id), session.idHash));

const body = z.union([z.object({ id: z.string().min(8).max(64) }), z.object({ all: z.literal(true) })]);

export const DELETE = route({ auth: "admin", body, recent: true }, ({ user, params, body, session, ip, zone }) => {
  const id = String(params.id);
  const row = personOrThrow(id);
  const n = revokeSessionsOf(id, body, session.idHash);
  audit(
    user,
    { action: "people.sessions_revoked", target: id, summary: "all" in body ? `Signed ${describePerson(row)} out everywhere (${n} device${n === 1 ? "" : "s"})` : `Signed ${describePerson(row)} out of a device` },
    { ip, zone },
  );
  return { ok: true, revoked: n };
});
