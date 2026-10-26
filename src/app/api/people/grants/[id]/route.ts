import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { deleteGrant, updateGrant } from "@/server/people/access";

const patch = z.object({ label: z.string().trim().max(60).nullable().optional(), access: z.enum(["read", "write"]).optional() });

export const PATCH = route({ auth: "admin", body: patch, recent: true }, ({ user, params, body, ip, zone }) => {
  const { before, after } = updateGrant(String(params.id), body);
  const summary =
    before.access !== after.access
      ? `${after.userName} can ${after.access === "write" ? "now change" : "now only view"} ${after.path}`
      : `Relabelled ${after.path} for ${after.userName}`;
  audit(user, { action: "people.folder_updated", target: after.path, summary }, { ip, zone });
  return after;
});

export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => {
  const g = deleteGrant(String(params.id));
  audit(user, { action: "people.folder_revoked", target: g.path, summary: `Stopped sharing ${g.path} with ${g.userName}` }, { ip, zone });
  return { ok: true };
});
