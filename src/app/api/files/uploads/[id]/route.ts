import { z } from "zod";
import { route } from "@/server/api";
import { cancelUpload, getUpload, putChunk } from "@/server/files/upload";

const id = (params: Record<string, string | string[]>) => String(params.id);

/** Where to resume: { received, size, status }. */
export const GET = route({ auth: "user" }, ({ user, params }) => getUpload(user, id(params)));

/** Send bytes starting at ?offset= (raw body, application/octet-stream). */
export const PUT = route({ auth: "user", query: z.object({ offset: z.coerce.number().int().min(0) }) }, ({ req, user, params, query }) =>
  putChunk(user, id(params), query.offset, req.body),
);

/** Cancel and discard the partial upload. */
export const DELETE = route({ auth: "user" }, ({ user, params }) => {
  cancelUpload(user, id(params));
  return { ok: true };
});
