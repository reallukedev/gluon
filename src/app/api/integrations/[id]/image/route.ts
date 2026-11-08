import { route } from "@/server/api";
import { proxyImage } from "@/server/integrations/images";

/** Only ids a widget handed out are served. */
export const GET = route({ auth: "user" }, ({ user, params, req }) =>
  proxyImage(user, String(Array.isArray(params.id) ? params.id[0] : params.id), req.nextUrl.searchParams),
);
