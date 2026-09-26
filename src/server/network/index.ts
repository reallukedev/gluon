import "server-only";
import { registerSearch } from "../search";
import { tryReadConfig, routeUrl } from "../caddy/routes";
import { onStart } from "../jobs";
import { networkStatus } from "./status";
import "./checks";

/** Network domain: checks (./checks), search provider, and a warm status cache at start-up. */

registerSearch((user, q) => {
  if (user.role !== "admin") return null;
  const cfg = tryReadConfig();
  if (!cfg) return null;
  const term = q.toLowerCase();
  const items: { id: string; label: string; hint?: string; icon?: string; href?: string; external?: boolean }[] = [];
  const fb = `https://${cfg.base_domain}/`;
  if (cfg.fallback.name.toLowerCase().includes(term) || cfg.base_domain.includes(term)) {
    items.push({ id: "route:__fallback__", label: `${cfg.fallback.name} (everything else)`, hint: fb.replace(/^https:\/\//, ""), icon: "globe", href: "/network?route=__fallback__" });
  }
  for (const r of cfg.routes) {
    const url = routeUrl(cfg, r);
    const hay = [r.name, r.app ?? "", url, r.type === "redirect" ? r.target : `${r.backend.host}:${r.backend.port}`, r.note ?? ""].join(" ").toLowerCase();
    if (!hay.includes(term)) continue;
    items.push({
      id: `route:${r.id}`,
      label: r.name,
      hint: `${url.replace(/^https:\/\//, "")}${r.enabled === false ? " · off" : r.type === "redirect" ? ` → ${r.target.replace(/^https?:\/\//, "")}` : ""}`,
      icon: "globe",
      href: `/network?route=${encodeURIComponent(r.id)}`,
    });
    if (items.length >= 8) break;
  }
  return { name: "Public addresses", items };
});

onStart("network-status", () => {
  // Warm the cache so the Network page opens with data; errors surface on the page itself.
  setTimeout(() => void networkStatus().catch(() => undefined), 15_000);
});
