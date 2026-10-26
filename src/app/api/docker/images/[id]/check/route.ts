import { z } from "zod";
import { route } from "@/server/api";
import { getImage, localDigests, remoteState } from "@/server/dockerx/images";
import { AppError } from "@/server/errors";
import { param } from "../../../params";

/** Ask the registry whether a tag has moved on since this copy was downloaded. */
export const POST = route({ auth: "admin", body: z.object({ tag: z.string().max(400) }), burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body }) => {
  const img = await getImage(param(params.id));
  if (!img.tags.includes(body.tag)) throw new AppError("not_found", `${body.tag} isn't a tag of this image any more.`, 404);
  const r = await remoteState(body.tag, localDigests(img), true);
  return { status: r.status, message: r.message ?? null };
});
