import { z } from "zod";
import { route } from "@/server/api";
import { favicon } from "@/server/favicon";

export const GET = route({ auth: "user", query: z.object({ url: z.string().min(4).max(2000) }), burst: { limit: 120, windowMs: 60_000 } }, async ({ query, user }) => {
  const icon = await favicon(query.url, user.role === "admin" ? "trusted" : "member");
  if (!icon) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=3600" } });
  const svg = icon.type.includes("svg");
  return new Response(new Uint8Array(icon.body), {
    headers: {
      "Content-Type": icon.type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      // SVGs can carry scripts; neutralise them when rendered.
      ...(svg ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
});
