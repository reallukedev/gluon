import { z } from "zod";
import { route } from "@/server/api";
import { checkApp } from "@/server/appstore/service";

/** Checks that need the server: ports in use, names Umbrel has, container names, images. */
export const POST = route({ auth: "admin", body: z.object({ images: z.boolean().optional() }), burst: { limit: 30, windowMs: 60_000 } }, ({ params, body }) => checkApp(String(params.id), { images: body.images }));
