import { route } from "@/server/api";
import { counts } from "@/server/findings";
import { listPins } from "@/server/pins";
import { one } from "@/server/db";
import { currentAnnouncements } from "@/server/people/household";

/** Small, frequently-polled payload for the sidebar: badges and pins. */
export const GET = route({ auth: "user" }, async ({ user }) => {
  const isAdmin = user.role === "admin";
  const c = isAdmin ? counts() : { fault: 0, attention: 0 };
  const reports = isAdmin ? (one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL")?.n ?? 0) : 0;
  const announcements = await currentAnnouncements(user, 5);
  return { fault: c.fault, attention: c.attention, reports, pins: listPins(user.id), announcements };
});
