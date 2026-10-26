import { z } from "zod";
import { route } from "@/server/api";
import { cleanupPlan, runCleanup } from "@/server/dockerx/disk";
import { audit } from "@/server/audit";

const kind = z.enum(["images", "containers", "volumes", "buildcache"]);

/** Preview: exactly what a cleanup would remove, what it keeps and why. */
export const GET = route({ auth: "admin", query: z.object({ kind }) }, ({ query }) => cleanupPlan(query.kind));

/** Remove the items the person ticked in the preview (each checked again first). */
export const POST = route({ auth: "admin", recent: true, body: z.object({ kind, ids: z.array(z.string().min(1).max(200)).max(2000) }) }, async ({ body, user, ip, zone }) => {
  const r = await runCleanup(body.kind, body.ids);
  const what = { images: "unused images", containers: "stopped containers", volumes: "unused volumes", buildcache: "the build cache" }[body.kind];
  audit(user, { action: `docker.cleanup.${body.kind}`, summary: r.removed || body.kind === "buildcache" ? r.message.replace(/\.$/, "") : `Tried to remove ${what}`, detail: { asked: body.ids.length, removed: r.removed, freed: r.freed, skipped: r.skipped }, outcome: r.removed || body.kind === "buildcache" || !body.ids.length ? "ok" : "failed" }, { ip, zone });
  return r;
});
