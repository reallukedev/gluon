import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { all } from "@/server/db";
import { notFound } from "@/server/errors";
import { changeRole, describePerson, listPeople, personOrThrow, removePerson, rename, sessionsOf, setDisabled } from "@/server/people/users";
import { listGrants } from "@/server/people/access";

/** One person: their summary, signed-in devices, folder grants and individually granted apps. */
export const GET = route({ auth: "admin" }, ({ user, params, session }) => {
  const id = String(params.id);
  const person = listPeople(user).find((p) => p.id === id);
  if (!person) throw notFound("That person");
  return {
    person,
    sessions: sessionsOf(id, session.idHash),
    grants: listGrants(id),
    apps: all<{ app_id: string }>("SELECT app_id FROM app_access WHERE user_id = ?", id).map((r) => r.app_id),
  };
});

const patch = z
  .object({
    displayName: z.string().trim().min(1, "Enter a name.").max(60).optional(),
    role: z.enum(["admin", "member"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.role !== undefined || v.disabled !== undefined, "Nothing to change.");

export const PATCH = route({ auth: "admin", body: patch, recent: true }, ({ user, params, body, ip, zone }) => {
  const id = String(params.id);
  const before = personOrThrow(id);
  if (body.displayName !== undefined && body.displayName !== before.display_name) {
    rename(id, body.displayName);
    audit(user, { action: "people.renamed", target: id, summary: `Renamed ${before.display_name} to ${body.displayName}` }, { ip, zone });
  }
  if (body.role !== undefined && body.role !== before.role) {
    changeRole(id, body.role);
    audit(user, { action: "people.role", target: id, summary: `Made ${describePerson(before)} ${body.role === "admin" ? "an admin" : "a household member"}` }, { ip, zone });
  }
  if (body.disabled !== undefined && body.disabled !== !!before.disabled) {
    setDisabled(user, id, body.disabled);
    audit(user, { action: body.disabled ? "people.disabled" : "people.enabled", target: id, summary: `${body.disabled ? "Turned off" : "Turned on"} ${describePerson(before)}'s account` }, { ip, zone });
  }
  return listPeople(user).find((p) => p.id === id);
});

export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => {
  const row = removePerson(user, String(params.id));
  audit(user, { action: "people.removed", target: row.id, summary: `Removed ${describePerson(row)}` }, { ip, zone });
  return { ok: true };
});
