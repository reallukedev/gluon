import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { readFile, siteRow, writeText } from "@/server/sites/store";
import { pathStr, siteId } from "../../_shared";

/** One file, as text when the editor can open it. */
export const GET = route({ auth: "admin", query: z.object({ path: pathStr }) }, ({ params, query }) => {
  const id = siteId(params);
  siteRow(id);
  return readFile(id, query.path);
});

/** Save text. `etag` is what the editor opened (null for a new file); a mismatch means it changed elsewhere. `force` saves over it anyway. */
export const PUT = route(
  { auth: "admin", maxBody: 3 * 1024 * 1024, body: z.object({ path: pathStr, text: z.string(), etag: z.string().max(64).nullable(), force: z.boolean().optional() }) },
  async ({ user, params, body, ip, zone }) => {
    const id = siteId(params);
    const site = siteRow(id);
    let etag = body.etag;
    if (body.force && etag !== null) {
      const cur = readFile(id, body.path);
      etag = cur.etag;
    }
    const r = await writeText(id, user, body.path, body.text, etag);
    audit(user, { action: r.created ? "sites.files.create" : "sites.files.edit", target: site.name, summary: `${r.created ? "Made" : "Edited"} ${body.path} in ${site.name}`, detail: { site: id, path: body.path, bytes: Buffer.byteLength(body.text) } }, { ip, zone });
    return r;
  },
);
