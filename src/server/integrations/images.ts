import "server-only";
import { AppError, notFound } from "../errors";
import type { User } from "../auth/users";
import { KINDS } from "./registry";
import { contextFor, readableRecord } from "./store";
import { client } from "./kinds/base";
import { isImageAllowed } from "./image-refs";
import { toWebStream } from "./net";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif"]);

/**
 * Stream a poster / cover / thumbnail from a connected app with its credentials added server-side.
 * Not an open proxy: the integration must be readable by this person, the parameters must match the kind's
 * schema, and the id must be one a widget handed out recently.
 */
export async function proxyImage(user: User, id: string, search: URLSearchParams): Promise<Response> {
  const rec = readableRecord(user, id);
  const def = KINDS[rec.kind];
  if (!def.image) throw notFound("That image");
  const parsed = def.image.schema.safeParse(Object.fromEntries(search));
  if (!parsed.success) throw new AppError("invalid", "That image address isn't valid.", 400);
  const params = parsed.data;
  if (!isImageAllowed(rec.id, def.image.ref(params))) throw new AppError("not_found", "That image isn't available any more. Refresh the page.", 404);

  const ctx = contextFor(rec);
  const req = def.image.request(ctx, params);
  const r = await client(def, ctx, () => `${def.label} didn't accept Gluon's credentials for this image.`).stream(req.path, {
    query: req.query,
    headers: { Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8" },
  });
  const type = String(r.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    r.stream.destroy();
    throw new AppError("upstream", `${def.label} didn't send an image.`, 502);
  }
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  };
  const etag = r.headers.etag;
  if (typeof etag === "string" && etag.length < 200) headers.ETag = etag;
  const lm = r.headers["last-modified"];
  if (typeof lm === "string" && lm.length < 100) headers["Last-Modified"] = lm;
  return new Response(toWebStream(r.stream), { status: 200, headers });
}
