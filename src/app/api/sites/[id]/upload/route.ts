import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { siteRow, writeUpload } from "@/server/sites/store";
import { pathStr, siteId } from "../../_shared";

/** One file, as the raw request body (application/octet-stream), to `path`. `replace=1` overwrites one that's there. */
export const POST = route({ auth: "admin", query: z.object({ path: pathStr, replace: z.enum(["0", "1"]).optional() }) }, async ({ req, user, params, query, ip, zone }) => {
  const id = siteId(params);
  const site = siteRow(id);
  const declared = Number(req.headers.get("content-length") ?? "");
  const r = await writeUpload(id, user, query.path, req.body, Number.isFinite(declared) && declared > 0 ? declared : null, query.replace === "1");
  audit(user, { action: "sites.files.upload", target: site.name, summary: `${r.replaced ? "Replaced" : "Uploaded"} ${r.path} in ${site.name}`, detail: { site: id, path: r.path } }, { ip, zone });
  return r;
});
