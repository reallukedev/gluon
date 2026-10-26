import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { normalizeRef, pullImage } from "@/server/dockerx/images";
import { audit } from "@/server/audit";

/** Download (or refresh) an image, streaming per-layer progress as NDJSON `PullEvent`s. */
export const POST = route({ auth: "admin", body: z.object({ ref: z.string().max(400) }), burst: { limit: 10, windowMs: 60_000 } }, ({ req, body, user, ip, zone }) => {
  const ref = normalizeRef(body.ref);
  return ndjson(async (emit) => {
    const r = await pullImage(ref, emit, req.signal);
    emit({ type: "done", ok: r.ok, message: r.message, changed: r.changed, imageId: r.imageId ?? undefined });
    audit(user, { action: "docker.image.pull", target: ref, summary: r.ok ? (r.changed ? `Downloaded ${ref}` : `Checked ${ref}; it was up to date`) : `Couldn't download ${ref}`, detail: { message: r.message }, outcome: r.ok ? "ok" : "failed" }, { ip, zone });
  }, req.signal);
});
