import "server-only";
import { registerSearch } from "../search";
import { listApps, appsForMember } from "./apps";

registerSearch(async (user, q) => {
  const term = q.toLowerCase();
  const apps = user.role === "admin" ? await listApps() : await appsForMember(user.id);
  const items = apps
    .filter((a) => a.name.toLowerCase().includes(term) || a.id.toLowerCase().includes(term) || a.containers.some((c) => c.name.toLowerCase().includes(term)))
    .slice(0, 8)
    .map((a) => ({
      id: `app:${a.id}`,
      label: a.name,
      hint: user.role === "admin" ? `${a.summary} · ${a.containers.length} container${a.containers.length === 1 ? "" : "s"}` : a.summary,
      icon: "app",
      href: user.role === "admin" ? `/apps/${encodeURIComponent(a.id)}` : (a.urls.home ?? a.urls.away ?? "/"),
      external: user.role !== "admin",
    }));
  return { name: "Apps", items };
});
