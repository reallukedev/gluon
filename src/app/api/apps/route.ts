import { route } from "@/server/api";
import { appsForMember, listApps } from "@/server/docker/apps";

export const GET = route({ auth: "user" }, async ({ user }) => {
  if (user.role === "admin") return listApps();
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
});
