import "server-only";
import { onStart, every } from "../jobs";
import { registerSearch, type ProviderItem } from "../search";
import { matchScore } from "@/lib/search-match";
import { raise } from "../findings";
import { getInventoryState } from "./inventory";
import { loadSmartCache, refreshSmart, pruneSmart, SMART_INTERVAL_MS } from "./smart";
import { markInterrupted, pruneJobs } from "./oplog";
import "./checks";

/** Storage: background SMART reads, recovery of interrupted operations, checks, remedies and search. */

async function smartPass() {
  const s = await getInventoryState();
  await refreshSmart(s.smartTargets);
}

onStart("storage", () => {
  for (const job of markInterrupted()) {
    if (job.kind !== "rename" && job.kind !== "setup") continue;
    const done = job.steps.filter((st) => st.status === "done").map((st) => st.label);
    raise({
      id: `storage.job:${job.id}`,
      kind: "storage.job",
      severity: "fault",
      subject: job.target,
      title: `"${job.title}" was interrupted`,
      cause: `Gluon stopped while this was running, so it couldn't finish or undo it.${done.length ? ` Already done: ${done.join("; ")}.` : " Nothing had been changed yet."} Check the drive and the apps that use it.`,
      detail: { jobId: job.id },
      remedy: { action: "", label: "See what happened", href: `/storage?job=${job.id}` },
    });
  }
  loadSmartCache();
  // Give the first page load priority; SMART can take a few seconds per disk.
  setTimeout(() => void smartPass().catch((e) => console.error("[gluon] SMART pass failed", e)), 15_000).unref?.();
  every(SMART_INTERVAL_MS, smartPass);
  every(24 * 60 * 60_000, () => {
    pruneSmart();
    pruneJobs();
  });
});

registerSearch({
  key: "storage",
  name: "Storage",
  priority: 40,
  async run(user, _q, ctx) {
    if (user.role !== "admin") return null;
    const s = await getInventoryState();
    const items: ProviderItem[] = [];
    for (const d of s.view.disks) {
      const kind = d.media === "hdd" ? "hard drive disk hdd" : d.media === "card" ? "card reader sd" : "ssd disk drive";
      const score = matchScore(ctx.query, { label: d.title, keywords: [d.model, d.serial, d.name, d.path, d.vendor, kind].filter(Boolean).join(" ") });
      if (score) items.push({ id: `disk:${d.id}`, label: `${d.title}${d.model ? ` · ${d.model}` : ""}`, hint: d.summary, icon: "disk", href: `/storage/${encodeURIComponent(d.id)}`, score });
    }
    const seen = new Set<string>();
    for (const r of s.volumes) {
      for (const m of r.vol.mounts) {
        if (seen.has(m.target)) continue;
        const score = matchScore(ctx.query, { label: m.target, keywords: [r.vol.label, r.vol.uuid, r.vol.name, "mount volume partition"].filter(Boolean).join(" ") });
        if (!score) continue;
        seen.add(m.target);
        items.push({
          id: `mount:${m.target}`,
          label: m.target,
          hint: `${m.bind ? "Bind mount of" : ""} ${r.vol.label ? `"${r.vol.label}" · ` : ""}${r.vol.name} on the ${r.disk.title}`.trim(),
          icon: "folder",
          href: `/storage?mount=${encodeURIComponent(m.target)}`,
          score,
        });
      }
    }
    return { name: "Storage", items };
  },
});

export {};
