import type { StatusPayload, StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import type { SpectrumGroup } from "@/components/spectrum/Spectrum";
import { instanceHints, sourceName } from "@/lib/app-names";

// Kept apart from the Status page so the Spectrum widget doesn't bring that whole page into Home's bundle.
export function spectrumGroups(apps: StatusApp[], findings: Finding[], filesystems: StatusPayload["filesystems"], fmtBytes: (n: number) => string): SpectrumGroup[] {
  const attentionSubjects = new Set(findings.filter((f) => f.severity === "attention").map((f) => f.subject));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const hints = instanceHints(apps.filter((a) => !(a.copyOf && byId.has(a.copyOf.id))));
  // An old copy sits inside the app it copies, a step apart, instead of taking a label of its own.
  const copies = new Map<string, StatusApp[]>();
  for (const a of apps) if (a.copyOf && byId.has(a.copyOf.id) && a.containers.length) copies.set(a.copyOf.id, [...(copies.get(a.copyOf.id) ?? []), a]);
  const lines = (a: StatusApp, copy: boolean) =>
    a.containers.map((c, i) => ({
      id: c.name,
      label: c.service ?? c.name,
      container: c.name,
      href: copy ? `/apps/${encodeURIComponent(a.id)}` : undefined,
      note: copy ? `Old copy from ${sourceName(a.source)}` : undefined,
      gapBefore: copy && i === 0,
      state: attentionSubjects.has(a.id) && c.line === "running" ? ("attention" as const) : c.line,
    }));
  const groups: SpectrumGroup[] = apps
    .filter((a) => a.containers.length && !(a.copyOf && byId.has(a.copyOf.id)))
    .map((a) => ({
      id: `app:${a.id}`,
      label: hints.get(a.id) ? `${a.name} · ${hints.get(a.id)}` : a.name,
      href: `/apps/${encodeURIComponent(a.id)}`,
      lines: [...lines(a, false), ...(copies.get(a.id) ?? []).flatMap((c) => lines(c, true))],
    }));
  if (filesystems.length) {
    groups.push({
      id: "storage",
      label: "Storage",
      href: "/storage",
      lines: filesystems
        .filter((f) => f.size > 512 * 1024 * 1024)
        .map((f) => {
          const finding = findings.find((x) => x.subject === f.mount);
          return {
            id: `fs:${f.mount}`,
            label: f.mount,
            state: finding ? (finding.severity === "fault" ? ("unhealthy" as const) : ("attention" as const)) : ("running" as const),
            detail: `${Math.round(f.pct)}% of ${fmtBytes(f.size)} used`,
            href: `/storage?usage=${encodeURIComponent(f.mount)}`,
          };
        }),
    });
  }
  return groups;
}
