import "server-only";
import { memInfo } from "../host/proc";
import { latestContainers } from "../metrics/sampler";
import { listApps } from "../docker/apps";
import type { MemoryBreakdown } from "@/lib/system-types";

/**
 * Memory split by app: each app's containers (from the metrics sampler, page cache excluded like
 * `docker stats`), and everything else the machine uses. Real numbers only; no estimates.
 */
export async function memoryBreakdown(): Promise<MemoryBreakdown> {
  const mem = memInfo();
  const sample = latestContainers();
  const apps = await listApps().catch(() => []);
  const byContainer = new Map((sample?.list ?? []).map((c) => [c.id, c.mem]));
  const out: MemoryBreakdown["apps"] = [];
  for (const a of apps) {
    let bytes = 0;
    let n = 0;
    for (const c of a.containers) {
      const m = byContainer.get(c.id);
      if (m === undefined) continue;
      bytes += m;
      n++;
    }
    if (n && bytes > 0) out.push({ id: a.id, name: a.name, bytes, containers: n });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  const appsTotal = out.reduce((s, a) => s + a.bytes, 0);
  return {
    total: mem.total,
    used: mem.used,
    available: mem.available,
    apps: out,
    other: Math.max(0, mem.used - appsTotal),
    swap: { total: mem.swapTotal, used: mem.swapUsed },
    at: sample?.t ?? Date.now(),
  };
}
