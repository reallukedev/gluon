import fs from "node:fs";
import mime from "mime";
import { z } from "zod";
import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { resolveDraft, sitePath, siteRow } from "@/server/sites/store";
import { disposition } from "@/server/files/stream";
import { isImage } from "@/lib/sites-types";
import { siteId } from "../../_shared";

/** A draft file's bytes: inline for images (the editor shows them), a download otherwise or with ?download=1. */
export const GET = route({ auth: "admin", query: z.object({ path: z.string().min(1).max(1000), download: z.enum(["0", "1"]).optional() }) }, ({ params, query }) => {
  const id = siteId(params);
  siteRow(id);
  const p = sitePath(query.path);
  const { abs, st } = resolveDraft(id, p);
  if (!st?.isFile()) throw notFound(`“${p}”`);
  const name = p.split("/").pop()!;
  const inline = query.download !== "1" && isImage(p);
  return new Response(new Uint8Array(fs.readFileSync(abs)), {
    headers: {
      "Content-Type": mime.getType(p) ?? "application/octet-stream",
      "Content-Length": String(st.size),
      "Content-Disposition": disposition(inline ? "inline" : "attachment", name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
