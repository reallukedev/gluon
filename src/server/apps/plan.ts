import "server-only";
import crypto from "node:crypto";
import type { MoveCopy, MovePlan, MoveSource } from "@/lib/app-move-types";
import { formatBytes } from "@/lib/format";
import type { Rewritten } from "./rewrite";

export interface Measured {
  size: number | null;
  missing: boolean;
  file: boolean;
}

export interface FinalizeInput {
  appId: string;
  name: string;
  source: MoveSource;
  newId: string;
  folder: string;
  rewritten: Rewritten;
  /** What `du` and `stat` found for each copy's source. */
  measured: Map<string, Measured>;
  /** Free bytes where the new folder goes, or null when it couldn't be checked. */
  free: number | null;
  /** "8096/tcp" → who else publishes it right now (not counting this app's own containers). */
  portsInUse: Map<string, string>;
  stops: MovePlan["stops"];
  /** Extra reasons found while gathering (folder taken, Umbrel unreachable). */
  blockers?: string[];
  warnings?: string[];
}

/** Room to spare beyond the copy itself: 5%, at least 512 MB. */
export const headroom = (bytes: number) => Math.max(512 * 1024 * 1024, Math.round(bytes * 0.05));

export function finalizePlan(input: FinalizeInput): MovePlan {
  const r = input.rewritten;
  const copies: MoveCopy[] = r.copies.map((c) => {
    const m = input.measured.get(c.from);
    return { ...c, kind: c.kind === "volume" ? "volume" : m?.file ? "file" : "folder", size: m?.size ?? null, missing: m?.missing ?? false };
  });
  const present = copies.filter((c) => !c.missing);
  const needed = present.reduce((n, c) => n + (c.size ?? 0), 0);
  const unmeasured = present.filter((c) => c.size === null).map((c) => c.from);
  const blockers = [...(input.blockers ?? []), ...r.blockers];
  const warnings = [...(input.warnings ?? []), ...r.warnings];
  const enough = input.free !== null && input.free >= needed + headroom(needed);
  if (input.free === null) blockers.push(`Gluon couldn't check how much space is free for ${input.folder}.`);
  else if (!enough) blockers.push(`The copy needs about ${formatBytes(needed + headroom(needed))} with room to spare, and ${formatBytes(input.free)} is free where it would go. Free some space first.`);
  if (unmeasured.length) warnings.push(`Gluon couldn't measure ${unmeasured.length === 1 ? unmeasured[0] : `${unmeasured.length} of the folders`} in time, so the space check leaves ${unmeasured.length === 1 ? "it" : "them"} out.`);
  for (const p of r.ports) {
    const who = input.portsInUse.get(`${p.host}/${p.proto}`);
    if (who) blockers.push(`Port ${p.host} is already used by ${who}. Stop it, or change the port, before moving.`);
  }
  const plan: Omit<MovePlan, "id"> = {
    appId: input.appId,
    name: input.name,
    source: input.source,
    newId: input.newId,
    folder: input.folder,
    compose: r.compose,
    copies,
    stays: r.stays,
    sharedVolumes: r.sharedVolumes,
    ports: r.ports,
    stops: input.stops,
    space: { needed, free: input.free, enough, unmeasured },
    warnings,
    blockers,
  };
  return { id: planId(plan, r.envText), ...plan };
}

/** Identifies what a move would do; sizes and free space aren't part of it (they change by the second). */
export function planId(p: Omit<MovePlan, "id">, envText: string | null): string {
  const material = {
    appId: p.appId,
    newId: p.newId,
    folder: p.folder,
    compose: p.compose,
    env: envText,
    copies: p.copies.map((c) => [c.from, c.to, c.kind]),
    stops: p.stops,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 20);
}
