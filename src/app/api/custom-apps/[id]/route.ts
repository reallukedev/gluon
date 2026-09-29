import { route } from "@/server/api";
import { appDetail, deleteDraft, saveDraft } from "@/server/appstore/service";
import { patchSchema } from "@/server/appstore/schemas";

const idOf = (p: Record<string, string | string[]>) => String(p.id);

export const GET = route({ auth: "admin" }, ({ params }) => appDetail(idOf(params)));

/** Autosave. `rev` must match the server's, so two tabs can't silently overwrite each other. */
export const PUT = route({ auth: "admin", body: patchSchema, maxBody: 1024 * 1024 }, ({ params, body }) => saveDraft(idOf(params), body));

/** Delete a draft (published apps are removed with /remove first). */
export const DELETE = route({ auth: "admin" }, ({ params, user, ip, zone }) => {
  deleteDraft(user, { ip, zone }, idOf(params));
  return { ok: true };
});
