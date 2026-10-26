import "server-only";
// Side-effect module: background housekeeping and ⌘K search for connected apps.
import { every, onStart } from "../jobs";
import { registerSearch } from "../search";
import { rank } from "@/lib/search-match";
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

registerSearch({
  key: "integrations",
  name: "Connected apps",
  priority: 65,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const items = rank(ctx.query, listRecords(), (r) => ({ label: r.name, keywords: `connected app integration widget ${r.kind} ${KINDS[r.kind]?.label ?? ""}` }))
      .slice(0, 8)
      .map(({ item: r, score }) => ({
        id: `integration:${r.id}`,
        label: r.name,
        hint: `Connected app · ${KINDS[r.kind]?.label ?? r.kind}`,
        icon: "link",
        href: `/settings/server#integration-${encodeURIComponent(r.id)}`,
        score,
      }));
    return { name: "Connected apps", items };
  },
});

export {};
