import "server-only";
import fs from "node:fs";
import { docker } from "../docker/client";
import { hostPath } from "../host/paths";
import { AppError } from "../errors";
import { formatBytes, listJoin, plural } from "@/lib/format";
import { dial, dockerError, dockerMessage, invalidateSnapshot, snapshot } from "./core";
import { afterChange, imageLabel, listImages, localDigests, remoteState } from "./images";
import { invalidateVolumeSizes, listVolumes, volumeSizes } from "./volumes";
import type { CleanupItem, CleanupKind, CleanupPlan, CleanupResult, DockerDisk } from "@/lib/docker-types";
import { sourceName } from "@/lib/app-names";

interface DfResponse {
  LayersSize?: number;
  Images?: { Id: string; Size?: number; SharedSize?: number; Containers?: number }[] | null;
  Containers?: { Id: string; State?: string; SizeRw?: number }[] | null;
  Volumes?: { Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number; RefCount?: number } | null }[] | null;
  BuildCache?: { ID: string; InUse?: boolean; Shared?: boolean; Size?: number }[] | null;
}

let dfCache: { at: number; value: Promise<DfResponse> } | null = null;

function df(fresh = false): Promise<DfResponse> {
  if (!fresh && dfCache && Date.now() - dfCache.at < 20_000) return dfCache.value;
  const value = dial<DfResponse>({ path: "/system/df", method: "GET", signal: AbortSignal.timeout(5 * 60_000) });
  dfCache = { at: Date.now(), value };
  value.catch(() => {
    dfCache = null;
  });
  return value;
}

export function invalidateDisk() {
  dfCache = null;
}

/** The mounted filesystem holding a host path (longest mount point that contains it). */
function fsFor(path: string): DockerDisk["fs"] {
  try {
    const mounts = fs
      .readFileSync("/proc/1/mounts", "utf8")
      .split("\n")
      .map((l) => l.split(" ")[1]?.replace(/\\040/g, " "))
      .filter((m): m is string => !!m && m.startsWith("/"));
    const mount = mounts.filter((m) => path === m || path.startsWith(m.endsWith("/") ? m : `${m}/`)).sort((a, b) => b.length - a.length)[0] ?? "/";
    const st = fs.statfsSync(hostPath(path));
    return { mount, size: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

export async function diskOverview(fresh = false): Promise<DockerDisk> {
  let d: DfResponse;
  let root: string | null = null;
  try {
    [d, root] = await Promise.all([
      df(fresh),
      (docker().info() as Promise<{ DockerRootDir?: string }>).then((i) => i.DockerRootDir ?? null).catch(() => null),
    ]);
  } catch (e) {
    throw dockerError(e, "Couldn't ask Docker how much space it uses");
  }
  const images = d.Images ?? [];
  const containers = d.Containers ?? [];
  const volumes = d.Volumes ?? [];
  const build = d.BuildCache ?? [];
  const own = (i: { Size?: number; SharedSize?: number }) => Math.max(0, (i.Size ?? 0) - (i.SharedSize && i.SharedSize > 0 ? i.SharedSize : 0));
  const imgBytes = d.LayersSize ?? images.reduce((a, i) => a + (i.Size ?? 0), 0);
  const ctrBytes = containers.reduce((a, c) => a + (c.SizeRw ?? 0), 0);
  const volSize = (v: (typeof volumes)[number]) => Math.max(0, v.UsageData?.Size ?? 0);
  const volBytes = volumes.reduce((a, v) => a + volSize(v), 0);
  const buildBytes = build.reduce((a, b) => a + (b.Size ?? 0), 0);
  const stopped = containers.filter((c) => c.State !== "running" && c.State !== "restarting" && c.State !== "paused");
  const unusedVols = volumes.filter((v) => v.UsageData?.RefCount === 0);
  return {
    root,
    fs: root ? fsFor(root) : null,
    total: imgBytes + ctrBytes + volBytes + buildBytes,
    images: { count: images.length, bytes: imgBytes, unused: images.filter((i) => !i.Containers).length, unusedBytes: images.filter((i) => !i.Containers).reduce((a, i) => a + own(i), 0) },
    containers: { count: containers.length, bytes: ctrBytes, stopped: stopped.length, stoppedBytes: stopped.reduce((a, c) => a + (c.SizeRw ?? 0), 0) },
    volumes: { count: volumes.length, bytes: volBytes, unused: unusedVols.length, unusedBytes: unusedVols.reduce((a, v) => a + volSize(v), 0) },
    buildCache: { count: build.length, bytes: buildBytes, reclaimable: build.filter((b) => !b.InUse && !b.Shared).reduce((a, b) => a + (b.Size ?? 0), 0) },
  };
}

// ---------------------------------------------------------------- previews

const reason = (why: string, label: string) => ({ label, reason: why });

async function imagePlan(): Promise<CleanupPlan> {
  const { images } = await listImages();
  const unused = images.filter((i) => i.use === "unused" || i.use === "leftover");
  const kept: CleanupPlan["kept"] = [];
  const items: CleanupItem[] = [];
  // Tagged images nothing uses: can they be downloaded again? Ask the registry (a few at a time).
  const tagged = unused.filter((i) => i.tags.length && !i.guard);
  const remote = new Map<string, Awaited<ReturnType<typeof remoteState>>>();
  for (let k = 0; k < tagged.length; k += 4) {
    await Promise.all(tagged.slice(k, k + 4).map(async (i) => remote.set(i.id, await remoteState(i.tags[0]!, localDigests(i)))));
  }
  for (const i of unused) {
    if (i.guard) {
      kept.push(reason(i.guard.message, imageLabel(i)));
      continue;
    }
    const r = remote.get(i.id);
    let caution: string | null = null;
    let note: string | null = null;
    if (i.use === "leftover") note = i.repo ? "Untagged: replaced by a newer download" : null;
    else if (i.olderOf) note = `Older version of the image ${i.olderOf.name} uses`;
    else if (i.baseOf.length) note = `Base of ${listJoin(i.baseOf.slice(0, 2))}; frees little`;
    else if (!i.tags.length) note = "Kept by digest only";
    if (r?.status === "missing") caution = "Built on this server or private: it can't be downloaded again.";
    else if (r?.status === "unknown" && i.tags.length) caution = "Gluon couldn't check whether it can be downloaded again.";
    items.push({
      id: i.id,
      label: i.tags[0] ?? i.repo ?? (i.built ? "Leftover build" : "Untagged image"),
      detail: i.tags.length > 1 ? `also ${i.tags.slice(1).join(", ")}` : i.short,
      note,
      bytes: i.own,
      preselect: !caution,
      caution,
      app: i.app,
    });
  }
  return { kind: "images", items, kept, bytes: items.reduce((a, i) => a + (i.bytes ?? 0), 0) };
}

async function containerPlan(): Promise<CleanupPlan> {
  invalidateSnapshot();
  const snap = await snapshot();
  const d = await df().catch(() => null);
  const sizes = new Map((d?.Containers ?? []).map((c) => [c.Id, c.SizeRw ?? 0]));
  const items: CleanupItem[] = [];
  const kept: CleanupPlan["kept"] = [];
  for (const c of snap.containers) {
    if (c.State === "running" || c.State === "restarting" || c.State === "paused") continue;
    const r = snap.refs.get(c.Id)!;
    if (r.self) {
      kept.push(reason("Gluon's own container.", r.name));
      continue;
    }
    if (r.platform) {
      kept.push(reason("Part of Umbrel; Umbrel manages it.", r.name));
      continue;
    }
    const app = snap.apps.find((a) => a.containers.some((x) => x.id === c.Id));
    const others = app ? app.containers.filter((x) => x.id !== c.Id) : [];
    let caution: string | null = null;
    if (app?.source === "umbrel") caution = `Umbrel recreates it (downloading its image if needed) the next time ${app.name} starts.`;
    else if (app?.source === "casaos") caution = `CasaOS recreates it the next time ${app.name} starts. Until then, ${app.name} ${others.length ? "is missing this part" : "leaves Apps"}.`;
    else if (app && app.kind === "stack") caution = `Compose recreates it the next time the ${app.name} stack starts.`;
    else caution = "Started by hand (docker run): the options it was started with go with it.";
    items.push({
      id: c.Id,
      label: r.name,
      detail: c.Image,
      note: app ? `${app.name} · ${sourceName(app.source)} · ${c.Status}` : c.Status,
      bytes: sizes.get(c.Id) ?? null,
      preselect: !app,
      caution,
      app: r.app,
    });
  }
  return { kind: "containers", items, kept, bytes: items.reduce((a, i) => a + (i.bytes ?? 0), 0) };
}

async function volumePlan(): Promise<CleanupPlan> {
  const [{ volumes }, sizes] = await Promise.all([listVolumes(), volumeSizes().catch(() => null)]);
  const items: CleanupItem[] = [];
  const kept: CleanupPlan["kept"] = [];
  for (const v of volumes) {
    if (v.containers.length) continue;
    if (v.guard) {
      kept.push(reason(v.guard.message, v.name));
      continue;
    }
    items.push({
      id: v.name,
      label: v.anonymous ? "Unnamed volume" : v.name,
      detail: v.anonymous ? v.name.slice(0, 12) : null,
      note: v.app ? `Was ${v.app.name}'s` : v.project ? `From the ${v.project} stack` : null,
      bytes: sizes?.sizes[v.name] ?? null,
      preselect: v.anonymous,
      caution: v.anonymous ? null : "Has a name, so it may hold an app's data (an app that's removed for now, or a backup).",
      app: v.app,
    });
  }
  return { kind: "volumes", items, kept, bytes: items.reduce((a, i) => a + (i.bytes ?? 0), 0) };
}

async function buildPlan(): Promise<CleanupPlan> {
  const d = await df(true);
  const free = (d.BuildCache ?? []).filter((b) => !b.InUse && !b.Shared);
  return { kind: "buildcache", items: [], kept: [], bytes: free.reduce((a, b) => a + (b.Size ?? 0), 0) };
}

export async function cleanupPlan(kind: CleanupKind): Promise<CleanupPlan> {
  try {
    if (kind === "images") return await imagePlan();
    if (kind === "containers") return await containerPlan();
    if (kind === "volumes") return await volumePlan();
    return await buildPlan();
  } catch (e) {
    throw dockerError(e, "Couldn't work out what can go");
  }
}

// ---------------------------------------------------------------- running

type G = typeof globalThis & { __gluonDockerCleanup?: boolean };
const g = globalThis as G;

/**
 * Remove exactly what the person ticked in the preview, each checked again against a fresh plan
 * (so something that started being used since is left alone). Docker's prune endpoints would also
 * take whatever became unused after the preview, and can't spare Gluon's base image or a named
 * volume, so only the build cache (which has no other way) uses one.
 */
export async function runCleanup(kind: CleanupKind, ids: string[]): Promise<CleanupResult> {
  if (g.__gluonDockerCleanup) throw new AppError("busy", "A Docker cleanup is already running. Wait for it to finish.", 409);
  g.__gluonDockerCleanup = true;
  try {
    return await run(kind, ids);
  } finally {
    g.__gluonDockerCleanup = false;
    afterChange();
    invalidateDisk();
    invalidateVolumeSizes();
  }
}

async function run(kind: CleanupKind, ids: string[]): Promise<CleanupResult> {
  if (kind === "buildcache") {
    try {
      const r = await dial<{ SpaceReclaimed?: number; CachesDeleted?: string[] | null }>({ path: "/build/prune", method: "POST", signal: AbortSignal.timeout(10 * 60_000) });
      const freed = r.SpaceReclaimed ?? 0;
      return { message: freed ? `Cleared the build cache, freeing ${formatBytes(freed)}.` : "The build cache had nothing to let go of.", freed, removed: r.CachesDeleted?.length ?? 0, skipped: [] };
    } catch (e) {
      throw dockerError(e, "Couldn't clear the build cache");
    }
  }
  const plan = await cleanupPlan(kind);
  const allowed = new Map(plan.items.map((i) => [i.id, i]));
  const snap = kind === "containers" ? await snapshot() : null;
  const nameOf = (id: string) => snap?.refs.get(id)?.name ?? (/^(sha256:)?[0-9a-f]{64}$/.test(id) ? id.replace(/^sha256:/, "").slice(0, 12) : id);
  const skipped: CleanupResult["skipped"] = [];
  let removed = 0;
  let freed = 0;
  const before = kind === "images" ? await dial<{ LayersSize?: number }>({ path: "/system/df", method: "GET", query: { type: "image" } }).catch(() => null) : null;
  for (const id of [...new Set(ids)]) {
    const item = allowed.get(id);
    if (!item) {
      skipped.push({ label: nameOf(id), reason: "It's in use now, protected, or already gone, so it was left alone." });
      continue;
    }
    try {
      if (kind === "images") await removeUnusedImage(id);
      else if (kind === "containers") await docker().getContainer(id).remove({ v: false, force: false });
      else await docker().getVolume(id).remove();
      removed++;
      freed += item.bytes ?? 0;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404) continue;
      skipped.push({ label: item.label, reason: e instanceof AppError ? e.message : dockerMessage(e) || "Docker refused." });
    }
  }
  if (kind === "images" && before?.LayersSize) {
    const after = await dial<{ LayersSize?: number }>({ path: "/system/df", method: "GET", query: { type: "image" } }).catch(() => null);
    if (after?.LayersSize !== undefined) freed = Math.max(0, before.LayersSize - after.LayersSize);
  }
  const noun = { images: "image", containers: "stopped container", volumes: "volume" }[kind];
  const message = removed ? `Removed ${plural(removed, noun)}${freed ? `, freeing ${formatBytes(freed)}` : ""}.` : `Nothing was removed.`;
  return { message: skipped.length ? `${message} ${plural(skipped.length, "item")} stayed.` : message, freed: removed ? freed : 0, removed, skipped };
}

async function removeUnusedImage(id: string) {
  const img = await docker().getImage(id).inspect();
  const refs = [...(img.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"), ...(img.RepoDigests ?? [])];
  const del = (ref: string) => dial({ path: `/images/${ref}`, method: "DELETE", query: { force: false, noprune: false } });
  if (!refs.length) return void (await del(img.Id));
  for (const r of refs) {
    try {
      await del(r);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }
  try {
    await docker().getImage(img.Id).inspect();
    await del(img.Id);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e;
  }
}

