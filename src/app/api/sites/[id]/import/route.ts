import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { importZip, readBody } from "@/server/sites/import";
import { sitePath, siteRow } from "@/server/sites/store";
import { SITE_LIMITS } from "@/lib/sites-types";
import { plural } from "@/lib/format";
import { siteId } from "../../_shared";

/** Unpack a .zip (the raw request body) into the draft, or into the folder `into`. Same-named files are replaced. */
export const POST = route({ auth: "admin", query: z.object({ into: z.string().max(400).optional() }) }, async ({ req, user, params, query, ip, zone }) => {
  const id = siteId(params);
  const site = siteRow(id);
  const into = query.into ? sitePath(query.into, "into") : "";
  const zip = await readBody(req.body, SITE_LIMITS.zipBytes, "zip");
  const r = await importZip(id, user, zip, into);
  audit(
    user,
    { action: "sites.files.import", target: site.name, summary: `Imported a zip into ${site.name}${into ? `/${into}` : ""}: ${plural(r.added, "new file")}, ${plural(r.replaced, "replaced file")}${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, detail: { site: id, added: r.added, replaced: r.replaced, skipped: r.skipped.slice(0, 20) } },
    { ip, zone },
  );
  return r;
});
