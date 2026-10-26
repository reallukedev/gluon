import "server-only";
import type { User } from "@/server/auth/users";
import { appsForMember, listApps } from "@/server/docker/apps";
import { movingApps } from "./move";

/** The app list as GET /api/apps answers it. Home's first paint reads it too, so the two never disagree. */
export async function appsFor(user: User) {
  if (user.role === "admin") {
    const [apps, moving] = [await listApps(), movingApps()];
    return moving.size ? apps.map((a) => (moving.has(a.id) ? { ...a, moving: true } : a)) : apps;
  }
  // Members get a trimmed view: what the app is, whether it works, and where to open it.
  return (await appsForMember(user.id)).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    line: a.line,
    summary: a.summary,
    urls: a.urls,
  }));
}
