import "server-only";
import { registerSearch } from "../search";
import { rank } from "@/lib/search-match";
import { listSites } from "./service";

/** Side-effect module: Sites in search (admins). */

registerSearch({
  key: "sites",
  name: "Sites",
  priority: 30,
  run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const { sites } = listSites();
    const items = rank(ctx.query, sites, (s) => ({ label: s.name, keywords: `${s.address?.host ?? ""} site website page html` }))
      .slice(0, 6)
      .map(({ item: s, score }) => ({
        id: `site:${s.id}`,
        label: s.name,
        hint: !s.address ? (s.state === "broken" ? "Needs publishing again" : "Not published yet") : s.state === "live" ? s.address.host : s.state === "off" ? `${s.address.host} · offline` : s.state === "broken" ? `${s.address.host} · needs publishing again` : "Not published yet",
        icon: "sites",
        href: `/sites/${s.id}`,
        score,
      }));
    return { name: "Sites", items };
  },
});
