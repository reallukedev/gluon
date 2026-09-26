import { route } from "@/server/api";
import { counts } from "@/server/findings";
import { listPins } from "@/server/pins";
import { all, now, one } from "@/server/db";

/** Small, frequently-polled payload for the sidebar: badges and pins. */
export const GET = route({ auth: "user" }, ({ user }) => {
  const isAdmin = user.role === "admin";
  const c = isAdmin ? counts() : { fault: 0, attention: 0 };
  const reports = isAdmin ? (one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL")?.n ?? 0) : 0;
  const announcements = all<{ id: string; message: string; app_id: string | null; until: number | null }>(
    "SELECT id, message, app_id, until FROM announcements WHERE until IS NULL OR until > ? ORDER BY created_at DESC LIMIT 5",
    now(),
  );
  return { fault: c.fault, attention: c.attention, reports, pins: listPins(user.id), announcements };
});
