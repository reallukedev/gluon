import "server-only";
import { registerSearch } from "../search";
import { tryReadConfig, routeUrl } from "../caddy/routes";
import { every, onStart } from "../jobs";
import { invalidateStatus, networkStatus } from "./status";
import { syncChatCertificates } from "./xmpp-certs";
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
    const to = r.type === "redirect" ? r.target : r.type === "subdomain" ? r.redirect_to : undefined;
    const hay = [r.name, r.app ?? "", url, to ?? (r.type === "redirect" ? "" : `${r.backend.host}:${r.backend.port}`), r.note ?? ""].join(" ").toLowerCase();
    if (!hay.includes(term)) continue;
    items.push({
      id: `route:${r.id}`,
      label: r.name,
      hint: `${url.replace(/^https:\/\//, "")}${r.enabled === false ? " · off" : to ? ` → ${to.replace(/^https?:\/\//, "")}` : ""}`,
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

onStart("xmpp-certs", () => {
  // Healthy chat servers are rechecked every six hours; ones that need attention (a new domain
  // still waiting for Caddy, a reload that didn't take) every 15 minutes. The first run waits for Caddy.
  setTimeout(() => void syncChatCertificates().then(invalidateStatus).catch(() => undefined), 60_000).unref?.();
  every(15 * 60_000, () => syncChatCertificates({ onlyDue: true }).then(invalidateStatus));
});
