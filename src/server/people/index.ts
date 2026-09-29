import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch } from "../search";
import { peopleHref } from "@/lib/settings-links";
import { all } from "../db";
import { pruneAnnouncements } from "./household";

/** Side-effect module: people search (admins) and announcement pruning. */

onStart("people", () => {
  every(24 * 60 * 60_000, () => pruneAnnouncements(), { immediate: true });
});

registerSearch((user, q) => {
  if (user.role !== "admin") return null;
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = all<{ id: string; username: string; display_name: string; role: string; disabled: number }>(
    "SELECT id, username, display_name, role, disabled FROM users WHERE display_name LIKE ? OR username LIKE ? ORDER BY display_name COLLATE NOCASE LIMIT 6",
    like,
    like,
  );
  return {
    name: "People",
    items: rows.map((r) => ({
      id: `person:${r.id}`,
      label: r.display_name,
      hint: `${r.username} · ${r.role === "admin" ? "Admin" : "Household"}${r.disabled ? " · turned off" : ""}`,
      href: peopleHref({ person: r.id }),
    })),
  };
});
