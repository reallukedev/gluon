import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch } from "../search";
import { rank } from "@/lib/search-match";
import { peopleHref } from "@/lib/settings-links";
import { all } from "../db";
import { pruneAnnouncements } from "./household";

/** Side-effect module: people search (admins) and announcement pruning. */

onStart("people", () => {
  every(24 * 60 * 60_000, () => pruneAnnouncements(), { immediate: true });
});

registerSearch({
  key: "people",
  name: "People",
  priority: 50,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const rows = all<{ id: string; username: string; display_name: string; role: string; disabled: number }>("SELECT id, username, display_name, role, disabled FROM users ORDER BY display_name COLLATE NOCASE LIMIT 500");
    const items = rank(ctx.query, rows, (r) => ({ label: r.display_name, keywords: `${r.username} ${r.role === "admin" ? "admin" : "household member"} person account user` }))
      .slice(0, 6)
      .map(({ item: r, score }) => ({
        id: `person:${r.id}`,
        label: r.display_name,
        hint: `${r.username} · ${r.role === "admin" ? "Admin" : "Household"}${r.disabled ? " · turned off" : ""}`,
        icon: "person",
        href: peopleHref({ person: r.id }),
        score,
      }));
    return { name: "People", items };
  },
});
