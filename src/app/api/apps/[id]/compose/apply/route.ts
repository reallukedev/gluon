import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { applyCompose } from "@/server/docker/compose";
import { audit } from "@/server/audit";

const body = z.object({ content: z.string().max(512 * 1024), hash: z.string().max(64) });

export const POST = route({ auth: "admin", body, recent: true }, ({ req, params, body, user, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  return ndjson(async (emit) => {
    let result: { ok: boolean; message: string } | null = null;
    await applyCompose(id, body.content, body.hash, (e) => {
      if (e.type === "done") result = { ok: e.ok, message: e.message };
      emit(e);
    });
    const r = result as { ok: boolean; message: string } | null;
    audit(user, { action: "app.compose_edited", target: id, summary: r?.ok ? `Edited the compose file of ${id}` : `Tried to edit the compose file of ${id} (rolled back)`, outcome: r?.ok ? "ok" : "failed" }, { ip, zone });
  }, req.signal);
});
