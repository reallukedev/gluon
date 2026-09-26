import { z } from "zod";
import { ndjson, route } from "@/server/api";
import { previewOwnership } from "@/server/files/apps";
import { pathStr } from "../../_schemas";

/**
 * Count what "fix ownership" would change (NDJSON stream): {type:"progress",phase,done,toChange}
 * … then {type:"done",ok:true,message,preview:OwnershipPreview}. Give either app or uid(/gid).
 */
export const POST = route(
  {
    auth: "admin",
    body: z.object({ path: pathStr, app: z.string().max(200).optional(), uid: z.number().int().min(0).max(4294967294).optional(), gid: z.number().int().min(0).max(4294967294).optional() }),
  },
  ({ req, user, body }) =>
    ndjson(async (emit, signal) => {
      const preview = await previewOwnership(user, body, emit, signal);
      emit({ type: "done", ok: true, message: preview.summary, preview });
    }, req.signal),
);
