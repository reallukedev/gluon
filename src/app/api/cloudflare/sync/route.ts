import { route } from "@/server/api";
import { status, sync } from "@/server/cloudflare/service";

/** Check DNS against the public addresses now, instead of at the next 5-minute tick. */
export const POST = route({ auth: "admin", burst: { limit: 12, windowMs: 60_000 } }, async () => {
  await sync();
  return status();
});
