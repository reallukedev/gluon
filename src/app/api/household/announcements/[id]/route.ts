import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { deleteAnnouncement, updateAnnouncement } from "@/server/people/household";

const patch = z.object({
  message: z.string().trim().min(1, "Write the announcement.").max(500, "Keep it under 500 characters.").optional(),
  appId: z.string().max(200).nullable().optional(),
  until: z.number().int().positive().nullable().optional(),
});

export const PATCH = route({ auth: "admin", body: patch }, async ({ user, params, body, ip, zone }) => {
  const a = await updateAnnouncement(String(params.id), body);
  audit(user, { action: "household.announcement_updated", target: a.appId, summary: `Edited the announcement “${a.message.slice(0, 80)}”` }, { ip, zone });
  return a;
});

export const DELETE = route({ auth: "admin" }, ({ user, params, ip, zone }) => {
  const a = deleteAnnouncement(String(params.id));
  audit(user, { action: "household.announcement_deleted", target: a.app_id, summary: `Took down the announcement “${a.message.slice(0, 80)}”` }, { ip, zone });
  return { ok: true };
});
