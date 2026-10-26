import { z } from "zod";
import { route } from "@/server/api";
import { appIcon } from "@/server/icons";

// Reads the request (auth, fetch metadata), so it can never be prerendered at build time.
export const dynamic = "force-dynamic";

/** An app's icon through Gluon's own cache (see server/icons.ts). */
export const GET = route({ auth: "user", query: z.object({ u: z.string().min(8).max(2000) }), burst: { limit: 300, windowMs: 60_000 } }, async ({ query, user }) => {
  const icon = await appIcon(query.u, user.role === "admin" ? "trusted" : "member");
  if (!icon) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=600" } });
  return new Response(new Uint8Array(icon.body), {
    headers: {
      "Content-Type": icon.type,
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      // SVGs can carry scripts; neutralise them if one is ever opened directly.
      ...(icon.type.includes("svg") ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
});
