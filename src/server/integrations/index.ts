import "server-only";
// Side-effect module: background housekeeping and ⌘K search for connected apps.
import { every, onStart } from "../jobs";
import { registerSearch } from "../search";
import { pruneCache } from "./cache";
import { pruneImageRefs } from "./image-refs";
import { listRecords } from "./store";
import { KINDS } from "./registry";

onStart("integrations", () => {
  every(10 * 60_000, () => {
    pruneCache();
    pruneImageRefs();
  });
});

registerSearch((user, q) => {
  if (user.role !== "admin") return null;
  const term = q.toLowerCase();
  const items = listRecords()
    .filter((r) => r.name.toLowerCase().includes(term) || r.kind.includes(term) || (KINDS[r.kind]?.label ?? "").toLowerCase().includes(term))
    .slice(0, 8)
    .map((r) => ({
      id: `integration:${r.id}`,
      label: r.name,
      hint: `Connected app · ${KINDS[r.kind]?.label ?? r.kind}`,
      icon: "settings",
      href: `/settings/server#integration-${encodeURIComponent(r.id)}`,
    }));
  return { name: "Connected apps", items };
});

export {};
