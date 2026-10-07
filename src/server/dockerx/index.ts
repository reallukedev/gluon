import "server-only";
import { registerSearch, type ProviderItem } from "../search";
import { matchScore } from "@/lib/search-match";
import { formatBytes } from "@/lib/format";
import { listImages } from "./images";
import { listVolumes } from "./volumes";
import { listNetworks } from "./networks";

/** ⌘K finds images, volumes and networks by name (admins only). */
registerSearch({
  key: "docker",
  name: "Docker",
  scope: "apps",
  priority: 70,
  async run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const [images, volumes, networks] = await Promise.all([listImages().catch(() => null), listVolumes().catch(() => null), listNetworks().catch(() => null)]);
    const items: ProviderItem[] = [];
    for (const i of images?.images ?? []) {
      const names = i.tags.length ? i.tags : i.repo ? [i.repo] : [];
      let best = { name: "", score: 0 };
      for (const name of names) {
        const score = matchScore(ctx.query, { label: name, keywords: "image" });
        if (score > best.score) best = { name, score };
      }
      if (!best.score) continue;
      items.push({
        id: `image:${i.id}`,
        label: best.name,
        hint: `Image · ${formatBytes(i.size)}${i.app ? ` · ${i.app.name}` : i.containers.length ? "" : " · not used"}`,
        icon: "image-layers",
        href: `/apps/images?q=${encodeURIComponent(best.name)}`,
        score: best.score * 0.9,
      });
    }
    for (const v of volumes?.volumes ?? []) {
      if (v.anonymous) continue;
      const score = matchScore(ctx.query, { label: v.name, keywords: "volume" });
      if (score) items.push({ id: `volume:${v.name}`, label: v.name, hint: `Volume${v.app ? ` · ${v.app.name}` : v.containers.length ? "" : " · not used"}`, icon: "storage", href: `/apps/volumes?q=${encodeURIComponent(v.name)}`, score: score * 0.9 });
    }
    for (const n of networks?.networks ?? []) {
      const score = matchScore(ctx.query, { label: n.name, keywords: `network ${n.driver}` });
      if (score) items.push({ id: `network:${n.id}`, label: n.name, hint: `Network · ${n.driver}${n.subnets[0] ? ` · ${n.subnets[0].subnet}` : ""}`, icon: "network", href: `/apps/networks?q=${encodeURIComponent(n.name)}`, score: score * 0.9 });
    }
    return { name: "Docker", items };
  },
});
