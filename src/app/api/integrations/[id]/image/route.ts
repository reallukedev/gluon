import { route } from "@/server/api";
import { proxyImage } from "@/server/integrations/images";

/**
 * Poster / cover / thumbnail from a connected app, e.g.
 *   jellyfin: ?item=<32 hex>&type=Primary|Backdrop|Thumb&tag=<tag>&w=<px>
 *   immich:   ?asset=<uuid>&size=thumbnail|preview
 *   subsonic: ?cover=<id>&w=<px>
 * Widget data already contains these URLs; only ids a widget handed out are served.
 */
export const GET = route({ auth: "user" }, ({ user, params, req }) =>
  proxyImage(user, String(Array.isArray(params.id) ? params.id[0] : params.id), req.nextUrl.searchParams),
);
