import "server-only";
import { registerSearch } from "../search";
import { formatBytes } from "@/lib/format";
import { listImages } from "./images";
import { listVolumes } from "./volumes";
import { listNetworks } from "./networks";

/** ⌘K finds images, volumes and networks by name (admins only). */
registerSearch(async (user, q) => {
  if (user.role !== "admin") return null;
  const term = q.toLowerCase();
  const [images, volumes, networks] = await Promise.all([
    listImages().catch(() => null),
    listVolumes().catch(() => null),
    listNetworks().catch(() => null),
  ]);
  const items: { id: string; label: string; hint?: string; icon?: string; href?: string }[] = [];
  for (const i of images?.images ?? []) {
    const name = i.tags.find((t) => t.toLowerCase().includes(term)) ?? (i.repo?.toLowerCase().includes(term) ? i.repo : null);
    if (!name) continue;
    items.push({
      id: `image:${i.id}`,
      label: name,
      hint: `Image · ${formatBytes(i.size)}${i.app ? ` · ${i.app.name}` : i.containers.length ? "" : " · not used"}`,
      icon: "apps",
      href: `/apps/images?q=${encodeURIComponent(name)}`,
    });
  }
  for (const v of volumes?.volumes ?? []) {
    if (v.anonymous || !v.name.toLowerCase().includes(term)) continue;
    items.push({ id: `volume:${v.name}`, label: v.name, hint: `Volume${v.app ? ` · ${v.app.name}` : v.containers.length ? "" : " · not used"}`, icon: "storage", href: `/apps/volumes?q=${encodeURIComponent(v.name)}` });
  }
  for (const n of networks?.networks ?? []) {
    if (!n.name.toLowerCase().includes(term)) continue;
    items.push({ id: `network:${n.id}`, label: n.name, hint: `Network · ${n.driver}${n.subnets[0] ? ` · ${n.subnets[0].subnet}` : ""}`, icon: "network", href: `/apps/networks?q=${encodeURIComponent(n.name)}` });
  }
  return items.length ? { name: "Docker", items: items.slice(0, 8) } : null;
});
