import { z } from "zod";
import { route } from "@/server/api";
import { siteRow } from "@/server/sites/store";
import { previewBase, signPreview } from "@/server/sites/preview";
import { SITE_VERSION_RE } from "@/server/caddy/routes";
import type { SitePreview } from "@/lib/sites-types";
import { siteId } from "../../_shared";

/** A preview link for the draft (or a published version), good for an hour. */
export const POST = route({ auth: "admin", body: z.object({ version: z.string().regex(SITE_VERSION_RE).optional() }) }, ({ params, body }): SitePreview => {
  const id = siteId(params);
  siteRow(id);
  const { token, expires } = signPreview(id, body.version ?? "draft");
  const base = previewBase(token);
  return { url: `${base}/index.html`, base, expiresAt: expires };
});
