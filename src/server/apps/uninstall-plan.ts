import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import type { UninstallItem, UninstallMode, UninstallPlan } from "@/lib/app-move-types";
import { inside, isBroadPath, norm, usersOf, within, type BindUse } from "./paths";
import { mediaKind } from "@/lib/builder/names";
import { formatBytes } from "@/lib/format";

/** A folder this big is only deleted when ticked by hand. */
export const BIG_FOLDER = 50e9;
import type { RuntimeMount, VolumeInfo } from "./rewrite";

/**
 * What uninstalling an app removes, in both modes. Pure. The one rule it exists to keep: nothing
 * outside the app's own folder, and no volume another container uses, ever lands in `removes`.
 */

export interface UninstallInput {
  appId: string;
  name: string;
  source: UninstallPlan["source"];
  /** Compose project and files, when Compose manages it. */
  project: string | null;
  configFiles: string[];
  workingDir: string | null;
  containers: { name: string; mounts: RuntimeMount[] }[];
  /** Volumes Compose labelled as this project's. */
  projectVolumes: VolumeInfo[];
  /** Every volume on the server (for who else uses what). */
  volumes: VolumeInfo[];
  /** Gluon-run apps: their folder (has the .gluon-app marker) and the apps roots it may live in. */
  gluonFolder: string | null;
  appsRoots: string[];
  /** Which run files exist in a Gluon-run app's folder. */
  runFiles: string[];
  /** CasaOS data folders that exist under names this app could use (/DATA/AppData/<id>). */
  casaDataDirs: string[];
  /** Every bind mount on the server, for who else uses a folder. */
  binds: BindUse[];
  sizes: Map<string, number | null>;
}

const RUN_FILES = ["docker-compose.yml", ".env", ".gluon-app"];
const CASA_APPS = "/var/lib/casaos/apps";

/** May `p` be deleted as part of an app whose own folder is `own`? */
export function deletable(p: string, own: string | null): boolean {
  const n = norm(p);
  const o = own ? norm(own) : null;
  if (!n || !o) return false;
  if (isBroadPath(n) || isBroadPath(o)) return false;
  return within(n, o);
}

export function buildUninstallPlan(input: UninstallInput): UninstallPlan {
  const size = (k: string) => input.sizes.get(k) ?? null;
  const names = new Set(input.containers.map((c) => c.name));
  const usedElsewhere = (v: VolumeInfo) => v.usedBy.some((u) => !names.has(u));
  const keep: UninstallMode = { removes: [], optional: [], keeps: [] };
  const all: UninstallMode = { removes: [], optional: [], keeps: [] };
  const both = (side: "removes" | "keeps", item: UninstallItem) => {
    keep[side].push(item);
    all[side].push(item);
  };
  const dir = (target: string, note?: string): UninstallItem => ({ kind: "folder", target, size: size(target), ...(note ? { note } : {}) });
  const others = (p: string) => usersOf(p, input.binds, names);
  /** A folder of the app's own: deletable with "everything", unless another container uses it. */
  const ownFolder = (p: string, keepNote?: string): boolean => {
    const who = others(p);
    if (who.length) {
      both("keeps", dir(p, `Also used by ${who.join(", ")}`));
      return false;
    }
    ownFolders.push(p);
    keep.keeps.push(dir(p, keepNote));
    const kind = mediaOf(p);
    const sz = size(p);
    if (kind) all.optional.push(dir(p, `Looks like ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} library`));
    else if (sz !== null && sz >= BIG_FOLDER) all.optional.push(dir(p, `Holds ${formatBytes(sz)}`));
    else all.removes.push(dir(p));
    return true;
  };
  /** A media library by its own name, or by where the app mounts it (/music, /data/movies). */
  const mediaOf = (p: string): string | null => {
    const own = mediaKind(p);
    if (own) return own;
    for (const c of input.containers) for (const m of c.mounts) if (m.type === "bind" && norm(m.source) && within(norm(m.source)!, p)) {
      const k = mediaKind(m.destination);
      if (k) return k;
    }
    return null;
  };
  const mounted = input.containers.flatMap((c) => c.mounts.filter((m) => m.type === "bind").map((m) => norm(m.source))).filter((x): x is string => !!x);
  const vol = (v: VolumeInfo, note?: string): UninstallItem => ({ kind: "volume", target: v.name, size: size(`volume:${v.name}`), ...(note ? { note } : {}) });

  const ownFolders: string[] = [];
  // Volumes: the project's own (compose apps), or the ones its containers mount (single containers).
  const candidates = new Map<string, VolumeInfo>();
  for (const v of input.projectVolumes) candidates.set(v.name, v);
  if (input.source === "docker" || !input.project) {
    for (const c of input.containers) for (const m of c.mounts) if (m.type === "volume" && m.name) {
      const info = input.volumes.find((v) => v.name === m.name);
      if (info) candidates.set(info.name, info);
    }
  }
  for (const v of candidates.values()) {
    if (usedElsewhere(v)) both("keeps", vol(v, `Also used by ${v.usedBy.filter((u) => !names.has(u)).join(", ")}`));
    else {
      keep.keeps.push(vol(v));
      all.removes.push(vol(v));
    }
  }


  if (input.source === "gluon") {
    const f = input.gluonFolder;
    const safe = !!f && input.appsRoots.some((r) => inside(f, r) && path.posix.dirname(norm(f)!) === norm(r)) && !isBroadPath(f);
    if (f && safe && ownFolder(norm(f)!, "Its data stays here")) {
      for (const name of RUN_FILES) if (input.runFiles.includes(name)) keep.removes.push({ kind: "file", target: `${norm(f)}/${name}`, size: null });
    }
  } else if (input.source === "casaos") {
    const file = input.configFiles[0] ? norm(input.configFiles[0]) : null;
    const casa = file ? path.posix.dirname(file) : null;
    if (casa && path.posix.dirname(casa) === CASA_APPS && deletable(casa, casa)) {
      const who = others(casa);
      if (who.length) both("keeps", dir(casa, `Also used by ${who.join(", ")}`));
      else both("removes", dir(casa, "CasaOS's copy of its settings, so CasaOS stops listing it"));
    }
    for (const raw of input.casaDataDirs) {
      const d = norm(raw);
      if (!d || path.posix.dirname(d) !== "/DATA/AppData" || !deletable(d, d)) continue;
      // Only a folder this app's own containers mount from: a second install can share a store id.
      if (!mounted.some((m) => within(m, d))) continue;
      ownFolder(d, "Its data");
    }
  } else if (input.source === "compose" && input.workingDir && !isBroadPath(input.workingDir)) {
    const wd = input.workingDir;
    const files = input.configFiles.map((f) => norm(f)).filter(Boolean) as string[];
    const seen = new Set<string>();
    for (const c of input.containers) {
      for (const m of c.mounts) {
        const src = norm(m.source);
        if (m.type !== "bind" || !src || seen.has(src) || !inside(src, wd)) continue;
        seen.add(src);
        // A folder that holds the compose file itself is the project, not its data.
        if (files.some((f) => within(f, src))) continue;
        if (!deletable(src, wd)) continue;
        ownFolder(src);
      }
    }
    both("keeps", dir(wd, "The project folder with its compose file"));
  }

  // Folders it uses from elsewhere on the server: never touched.
  const outside = new Set<string>();
  for (const c of input.containers) {
    for (const m of c.mounts) {
      const src = norm(m.source);
      if (m.type !== "bind" || !src || ownFolders.some((o) => within(src, o)) || all.keeps.some((k) => k.target === src)) continue;
      if (input.source === "compose" && input.workingDir && within(src, input.workingDir) && !isBroadPath(input.workingDir)) continue;
      outside.add(src);
    }
  }
  for (const p of outside) both("keeps", { kind: "folder", target: p, size: null, note: "Used in place; Gluon never deletes it" });

  // The guard, applied once more to the final list.
  const allowed = (i: UninstallItem) => {
    if (i.kind === "volume") return candidates.has(i.target) && !usedElsewhere(candidates.get(i.target)!);
    const t = norm(i.target);
    if (!t || t !== i.target || others(t).length) return false;
    return ownFolders.some((o) => deletable(t, o)) || (input.source === "casaos" && path.posix.dirname(t) === CASA_APPS && !isBroadPath(t));
  };
  keep.removes = keep.removes.filter(allowed);
  all.removes = all.removes.filter(allowed);
  all.optional = all.optional.filter(allowed);

  const managed = !!input.project && input.configFiles.length > 0;
  const plan: Omit<UninstallPlan, "id"> = {
    appId: input.appId,
    name: input.name,
    source: input.source,
    containers: input.containers.map((c) => c.name),
    via: managed ? "compose" : "containers",
    keep,
    everything: all,
  };
  const material = JSON.stringify({ ...plan, keep: strip(keep), everything: strip(all) });
  return { id: crypto.createHash("sha256").update(material).digest("hex").slice(0, 20), ...plan };
}

// Whether a folder is ticked by default depends on its size, which changes; the id only covers
// what may be deleted at all.
const strip = (m: UninstallMode) => ({ deletable: [...m.removes, ...m.optional].map((i) => `${i.kind}:${i.target}`).sort(), keeps: m.keeps.map((i) => `${i.kind}:${i.target}`).sort() });
