import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { host } from "../host/exec";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import { AppError, conflict, notFound } from "../errors";
import { audit } from "../audit";
import { raise } from "../findings";
import { all, run as dbRun, tx } from "../db";
import { docker } from "../docker/client";
import { invalidateApps, listApps } from "../docker/apps";
import { publish } from "../events";
import { sha256 } from "../crypto";
import { listJoin, plural } from "@/lib/format";
import type { User } from "../auth/users";
import { getInventoryState } from "./inventory";
import { validateMountTarget, mountAt, mountsUnder, readMountinfo, isSystemTarget, hostMkdirs, hostRemoveEmptyDirs, hostRealpaths, dirIsEmpty } from "./mounts";
import { applyChanges, formatEntry, readFstabText, restoreFstab, writeFstab, isSwapEntry, isBindEntry, matchesVolume, sourceRef, gluonComment, type FstabChange } from "./fstab";
import { findHolders } from "./holders";
import { boundVolumes, compose, resolvedVolumes, scanComposeText, scanEnvText, applyEdits, lineChanges, readHostText, writeHostTextAtomic, backupHostFile, restoreHostFile, movePath, mentionsPath, type ComposeProject, type ContainerRef } from "./compose";
import { acquireLock, Job } from "./oplog";
import { afterChange, persistEntry, mountError, type Where } from "./ops";
import { cancelUsageUnder } from "./usage";
import type { RenamePlan } from "@/lib/storage-types";

/**
 * Rename a mount point: /mnt/hdd2 → /mnt/photos, taking every app that uses it along.
 *
 * Plan (read-only): find containers binding folders from the old place, group them by app, find compose
 * files and .env values that spell out the old path, simulate the rewrite with `docker compose config`,
 * and describe the fstab change. Execute: stop apps → unmount → mkdir → fstab → mount → rewrite files →
 * (link) → start apps → verify. Every step records how to undo itself; any failure unwinds in reverse.
 */

export interface RenameInput {
  target: string;
  newPath: string;
  symlink: boolean;
  persist?: boolean;
}

interface AppWork {
  id: string;
  name: string;
  mode: "compose" | "containers";
  project: ComposeProject | null;
  affected: ContainerRef[];
  runningServices: string[];
  runningIds: string[];
  willStop: boolean;
}

interface FileWork {
  path: string;
  kind: "compose" | "env";
  before: string;
  after: string;
  apps: string[];
}

interface RenameWork {
  plan: RenamePlan;
  from: string;
  to: string;
  device: string;
  mountOptions: string[];
  apps: AppWork[];
  files: FileWork[];
  fstabChanges: FstabChange[];
  fstabHasTarget: boolean;
}

const MAX_FILE = 1024 * 1024;
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

function isSelf(c: ContainerRef): boolean {
  const selfId = (process.env.HOSTNAME ?? "").slice(0, 12);
  return c.name === "gluon" || c.name === "gluon-dev" || (!!selfId && c.id.startsWith(selfId));
}

function casaosComposeFiles(): string[] {
  const dir = "/var/lib/casaos/apps";
  try {
    return fs
      .readdirSync(hostPath(dir))
      .flatMap((app) => COMPOSE_NAMES.map((n) => `${dir}/${app}/${n}`))
      .filter((p) => fs.existsSync(hostPath(p)));
  } catch {
    return [];
  }
}

function readSmall(realPath: string): string | null {
  try {
    const st = fs.statSync(hostPath(realPath));
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return readHostText(realPath);
  } catch {
    return null;
  }
}

function gluonRefCounts(from: string) {
  const like = `${from}/%`;
  const count = (sql: string, ...p: unknown[]) => {
    try {
      return all<{ n: number }>(sql, ...p)[0]?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    folderGrants: count("SELECT COUNT(*) AS n FROM file_grants WHERE path = ? OR path LIKE ?", from, like),
    pins: count("SELECT COUNT(*) AS n FROM pins WHERE kind = 'folder' AND (target = ? OR target LIKE ?)", from, like),
    trash: count("SELECT COUNT(*) AS n FROM trash WHERE fs_root = ? OR fs_root LIKE ? OR original_path LIKE ?", from, like, like),
  };
}

/** Move Gluon's own saved paths (folder grants, pins, trash index) along with the mount. */
function moveGluonRefs(from: string, to: string) {
  const like = `${from}/%`;
  const n = from.length + 1;
  tx(() => {
    const safe = (sql: string, ...p: unknown[]) => {
      try {
        dbRun(sql, ...p);
      } catch {
        /* table owned by another module may not exist yet */
      }
    };
    safe("UPDATE file_grants SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ?", to, n, from, like);
    safe("UPDATE pins SET target = ? || substr(target, ?) WHERE kind = 'folder' AND (target = ? OR target LIKE ?)", to, n, from, like);
    safe("UPDATE trash SET fs_root = ? || substr(fs_root, ?) WHERE fs_root = ? OR fs_root LIKE ?", to, n, from, like);
    safe("UPDATE trash SET original_path = ? || substr(original_path, ?) WHERE original_path LIKE ?", to, n, like);
    safe("UPDATE trash SET trash_path = ? || substr(trash_path, ?) WHERE trash_path LIKE ?", to, n, like);
  });
}

/**
 * Write rewritten copies of compose/.env files for `docker compose config` to check. They go next to the
 * originals (hidden, removed right after) so relative env_file/extends paths resolve exactly the same.
 */
async function writeTempFiles(files: Map<string, string>): Promise<{ paths: Map<string, string>; cleanup: () => void }> {
  const tag = crypto.randomBytes(4).toString("hex");
  const paths = new Map<string, string>();
  const cleanup = () => {
    for (const p of paths.values()) {
      try {
        fs.unlinkSync(hostPath(p));
      } catch {
        /* already gone */
      }
    }
  };
  try {
    for (const [orig, text] of files) {
      const p = path.posix.join(path.posix.dirname(orig), `.${path.posix.basename(orig)}.gluon-check-${tag}`);
      fs.writeFileSync(hostPath(p), text, { mode: 0o600, flag: "wx" });
      paths.set(orig, p);
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { paths, cleanup };
}

export async function planRename(input: RenameInput): Promise<RenameWork> {
  const s = await getInventoryState(true);
  const blockers: string[] = [];
  const warnings: string[] = [];
  let from: string;
  try {
    from = normalizeHostPath(input.target.trim());
  } catch {
    throw new AppError("invalid_path", "Choose the mount point to rename.");
  }
  const mounts = readMountinfo();
  const m = mountAt(from, mounts);
  if (!m) throw notFound(`A drive mounted at ${from}`);
  const rec = s.volumes.find((r) => r.vol.primaryMount === from && r.vol.role === "filesystem");
  if (!rec) {
    const bind = s.volumes.find((r) => r.vol.mounts.some((x) => x.target === from && x.bind));
    throw new AppError("not_a_drive", bind ? `${from} is a bind mount (a second view of ${bind.vol.primaryMount}). Rename the drive's own mount point instead.` : `${from} isn't a drive Gluon can rename.`, 409);
  }
  if (isSystemTarget(from) || rec.disk.system) blockers.push(`${from} is on the system disk. Gluon won't move system mounts.`);
  const nested = mountsUnder(from, mounts);
  if (nested.length) {
    blockers.push(
      nested.length === 1
        ? `${nested[0]!.target} is mounted inside it. Unmount that first.`
        : `${nested.length} other things are mounted inside it (${nested.slice(0, 2).map((n) => n.target).join(", ")}${nested.length > 2 ? "…" : ""}). Unmount them first.`,
    );
  }

  const symlink = !!input.symlink;
  const persist = input.persist !== false;
  let to = input.newPath.trim();
  try {
    to = (await validateMountTarget(input.newPath, { ignoreMount: from, systemMounts: s.systemMounts })).path;
    if (to === from) blockers.push("That's where it is already.");
    if (isWithin(from, to)) blockers.push(`${to} contains the current mount point.`);
  } catch (e) {
    if (e instanceof AppError) blockers.push(e.message);
    else throw e;
  }

  // Containers binding folders from the old place (directly, or through a link that points into it).
  const containers = s.containers;
  const allSources = containers.flatMap((c) => c.binds.filter((b) => b.type === "bind").map((b) => b.source));
  const real = await hostRealpaths(allSources);
  const affectedIds = new Set<string>();
  for (const c of containers) {
    for (const b of c.binds) {
      if (b.type !== "bind" || !b.source.startsWith("/")) continue;
      const direct = isWithin(b.source, from);
      const viaLink = !direct && isWithin(real.get(b.source) ?? b.source, from);
      if (direct) affectedIds.add(c.id);
      else if (viaLink) {
        const msg = `${c.project ?? c.name} uses ${b.source}, which is a link into ${from}. The link won't follow the move.`;
        (symlink ? warnings : blockers).push(symlink ? `${msg} The compatibility link keeps it working.` : `${msg} Turn on the compatibility link, or update the link by hand first.`);
      }
    }
  }
  for (const v of await boundVolumes()) {
    if (!isWithin(v.device, from)) continue;
    const users = containers.filter((c) => c.binds.some((b) => b.volumeName === v.name)).map((c) => c.project ?? c.name);
    const msg = `The Docker volume ${v.name}${users.length ? ` (used by ${listJoin([...new Set(users)])})` : ""} stores its data in ${v.device}. Docker volumes can't be repointed.`;
    (symlink ? warnings : blockers).push(symlink ? `${msg} The compatibility link keeps it working.` : `${msg} Turn on the compatibility link to keep it working.`);
  }

  // Group affected containers into apps (named the way the Apps page names them).
  const known = await listApps().catch(() => []);
  const displayName = (id: string) => known.find((a) => a.id === id)?.name ?? id;
  const apps: AppWork[] = [];
  const byApp = new Map<string, ContainerRef[]>();
  for (const c of containers) {
    if (!affectedIds.has(c.id)) continue;
    const key = c.project ? `p:${c.project}` : `c:${c.name}`;
    byApp.set(key, [...(byApp.get(key) ?? []), c]);
  }
  for (const [key, cs] of byApp) {
    const first = cs[0]!;
    if (cs.some(isSelf) || known.some((a) => a.self && a.id === (first.project ?? first.name))) blockers.push(`Gluon itself uses ${from}. It can't stop itself to move it.`);
    if (key.startsWith("p:")) {
      const project = first.project!;
      const siblings = containers.filter((c) => c.project === project);
      const realFiles = [...(await hostRealpaths(first.configFiles)).values()];
      const filesOk = realFiles.length > 0 && realFiles.every((f) => fs.existsSync(hostPath(f)));
      const runningServices = [...new Set(siblings.filter((c) => c.running && c.service).map((c) => c.service!))];
      if (filesOk) {
        const wd = first.workingDir ? ((await hostRealpaths([first.workingDir])).get(first.workingDir) ?? first.workingDir) : null;
        const proj: ComposeProject = { project, files: realFiles, workingDir: wd && fs.existsSync(hostPath(wd)) ? wd : null };
        apps.push({ id: project, name: displayName(project), mode: "compose", project: proj, affected: cs, runningServices, runningIds: siblings.filter((c) => c.running).map((c) => c.id), willStop: runningServices.length > 0 });
      } else {
        const msg = `Gluon can't find the compose file for ${displayName(project)} (${first.configFiles.join(", ") || "none recorded"}), so its folders can't be updated.`;
        (symlink ? warnings : blockers).push(symlink ? `${msg} It will be restarted as-is and use the compatibility link.` : `${msg} Turn on the compatibility link to keep it working.`);
        apps.push({ id: project, name: displayName(project), mode: "containers", project: null, affected: cs, runningServices: [], runningIds: cs.filter((c) => c.running).map((c) => c.id), willStop: cs.some((c) => c.running) });
      }
    } else {
      const msg = `${first.name} wasn't started with Docker Compose, so the folders it uses can't be changed.`;
      (symlink ? warnings : blockers).push(symlink ? `${msg} It will be restarted and use the compatibility link.` : `${msg} Turn on the compatibility link, or recreate it with the new path.`);
      apps.push({ id: first.name, name: displayName(first.name), mode: "containers", project: null, affected: cs, runningServices: [], runningIds: cs.filter((c) => c.running).map((c) => c.id), willStop: cs.some((c) => c.running) });
    }
    const stopped = cs.filter((c) => !c.running);
    if (stopped.length && !cs.some((c) => c.running)) warnings.push(`${displayName(first.project ?? first.name)} isn't running now; its settings are updated but it won't be started.`);
  }

  // Compose files that spell out the old path: every project's files plus CasaOS's app folder.
  const candidates = new Map<string, Set<string>>(); // real path → projects
  const realConfig = await hostRealpaths(containers.flatMap((c) => c.configFiles));
  for (const c of containers) {
    if (!c.project) continue;
    for (const f of c.configFiles) {
      const r = realConfig.get(f) ?? f;
      candidates.set(r, (candidates.get(r) ?? new Set()).add(c.project));
    }
  }
  for (const f of (await hostRealpaths(casaosComposeFiles())).values()) if (!candidates.has(f)) candidates.set(f, new Set());
  const files: FileWork[] = [];
  const planFiles: RenamePlan["files"] = [];
  const sourceVarsByProject = new Map<string, Set<string>>();
  for (const [file, projects] of candidates) {
    const text = readSmall(file);
    if (text === null) continue;
    const appNames = [...projects];
    const involved = appNames.some((p) => apps.some((a) => a.id === p));
    const mentions = mentionsPath(text, from);
    // Files of affected apps are scanned even without a literal mention: their volume variables (from .env) matter.
    if (!mentions && !involved) continue;
    const scan = scanComposeText(text, from, to);
    if (scan.parseError) {
      if (mentions) (involved ? blockers : warnings).push(`${file} mentions ${from} but couldn't be read as YAML (${scan.parseError}).`);
      continue;
    }
    for (const p of projects) sourceVarsByProject.set(p, new Set([...(sourceVarsByProject.get(p) ?? []), ...scan.sourceVars]));
    if (!mentions) continue;
    if (scan.problems.length) {
      const msg = `In ${file}, Gluon can't safely edit: ${scan.problems.slice(0, 3).join("; ")}.`;
      (symlink || !involved ? warnings : blockers).push(symlink || !involved ? `${msg} Update it by hand.` : `${msg} Update it by hand first, or turn on the compatibility link.`);
    }
    const after = applyEdits(text, scan.edits);
    if (after !== text) files.push({ path: file, kind: "compose", before: text, after, apps: appNames });
    planFiles.push({ path: file, kind: "compose", apps: appNames.map(displayName), changes: lineChanges(text, after), untouched: scan.untouched });
  }
  // .env files next to affected projects: values that feed volume paths.
  for (const a of apps) {
    if (a.mode !== "compose" || !a.project) continue;
    const dir = a.project.workingDir ?? path.posix.dirname(a.project.files[0]!);
    const envPath = `${dir}/.env`;
    const text = readSmall(envPath);
    if (text === null || !mentionsPath(text, from) || files.some((f) => f.path === envPath)) continue;
    const scan = scanEnvText(text, from, to, sourceVarsByProject.get(a.id) ?? new Set());
    const after = applyEdits(text, scan.edits);
    if (after !== text) files.push({ path: envPath, kind: "env", before: text, after, apps: [a.id] });
    planFiles.push({ path: envPath, kind: "env", apps: [a.name], changes: lineChanges(text, after), untouched: scan.untouched });
  }

  // Prove the rewrite works: resolve each affected project with the new files and look for leftovers.
  if (!blockers.length) {
    for (const a of apps) {
      if (a.mode !== "compose" || !a.project) continue;
      try {
        await resolvedVolumes(a.project);
      } catch (e) {
        blockers.push(`Docker Compose can't read ${a.name}'s files as they are now, so Gluon couldn't safely restart it: ${(e as Error).message}`);
        continue;
      }
      const changed = new Map<string, string>();
      for (const f of files) if (a.project.files.includes(f.path) || (f.kind === "env" && f.apps.includes(a.id))) changed.set(f.path, f.after);
      if (!changed.size && !a.affected.length) continue;
      let tmp: Awaited<ReturnType<typeof writeTempFiles>> | null = null;
      try {
        tmp = await writeTempFiles(changed);
        const simFiles = a.project.files.map((f) => tmp!.paths.get(f) ?? f);
        const envFile = [...changed.keys()].find((k) => k.endsWith("/.env"));
        const vols = await resolvedVolumes(a.project, { files: simFiles, envFile: envFile ? tmp.paths.get(envFile) : undefined });
        const left = vols.filter((v) => (v.type === "bind" || v.type === "volume-device") && isWithin(v.source, from));
        if (left.length) {
          const msg = `After the change, ${a.name} would still use ${listJoin([...new Set(left.map((v) => v.source))].slice(0, 3))} (${listJoin([...new Set(left.map((v) => v.service))])}). The path comes from somewhere Gluon doesn't edit.`;
          (symlink ? warnings : blockers).push(symlink ? `${msg} The compatibility link keeps it working.` : `${msg} Turn on the compatibility link, or fix it by hand first.`);
        }
      } catch (e) {
        blockers.push(`Gluon couldn't check ${a.name}'s updated compose files: ${(e as Error).message}`);
      } finally {
        tmp?.cleanup();
      }
    }
  }

  // /etc/fstab.
  const fstabChanges: FstabChange[] = [];
  let fstabPlan: RenamePlan["fstab"] = { action: "none", line: null, before: null, after: null };
  let fstabHasTarget = false;
  {
    const own = s.fstab.lines.find((l) => l.entry && !isBindEntry(l.entry) && !isSwapEntry(l.entry) && matchesVolume(l.entry, rec.ident));
    if (own && own.entry) {
      const ref = sourceRef(own.entry);
      const spec = ref.kind === "device" && rec.vol.uuid ? `UUID=${rec.vol.uuid}` : own.entry.spec;
      const entry = { ...own.entry, spec, file: to };
      if (own.entry.file !== from) warnings.push(`/etc/fstab had this drive at ${own.entry.file}, not ${from}. That line will now say ${to}.`);
      fstabChanges.push({ kind: "replace", index: own.index, expectRaw: own.raw, entry });
      fstabPlan = { action: "update", line: own.index + 1, before: own.raw, after: formatEntry(entry) };
      fstabHasTarget = true;
    } else if (persist) {
      const entry = persistEntry(rec, to, { currentOptions: m.options, superOptions: m.superOptions });
      fstabChanges.push({ kind: "add", entry, comment: gluonComment(`${rec.disk.model ?? rec.disk.title} (${rec.vol.name})`) });
      fstabPlan = { action: "add", line: null, before: null, after: formatEntry(entry) };
      fstabHasTarget = true;
      warnings.push(`${from} wasn't in /etc/fstab. It will be added at ${to}, so it also comes back after a restart.`);
    }
    // Bind entries and mounts inside the old place move along.
    for (const l of s.fstab.lines) {
      if (!l.entry || l.entry === own?.entry) continue;
      const e = l.entry;
      const spec = isBindEntry(e) ? movePath(e.spec, from, to) : e.spec;
      const file = movePath(e.file, from, to);
      if (spec !== e.spec || file !== e.file) {
        fstabChanges.push({ kind: "replace", index: l.index, expectRaw: l.raw, entry: { ...e, spec, file } });
        warnings.push(`/etc/fstab line ${l.index + 1} also refers to ${from}; it will be updated.`);
      }
    }
  }

  // Other places that mention it but aren't edited.
  for (const f of ["/etc/samba/smb.conf", "/etc/exports"]) {
    const text = readSmall(f);
    if (text && mentionsPath(text, from)) warnings.push(`${f} refers to ${from}. Gluon doesn't edit it; update it after the move.`);
  }

  const ignore = new Set(apps.flatMap((a) => [...a.runningIds, ...a.affected.map((c) => c.id)]));
  const { holders } = await findHolders(from, { ignoreContainers: ignore, containers });
  if (holders.length) warnings.push(`${plural(holders.length, "other thing")} ${holders.length === 1 ? "is" : "are"} using ${from} right now. If still busy when the move starts, it stops and puts everything back.`);

  const gluonRefs = gluonRefCounts(from);
  const stopping = apps.filter((a) => a.willStop);
  const steps = [
    ...stopping.map((a) => `Stop ${a.name}`),
    `Make sure nothing else is using ${from}`,
    `Unmount ${from}`,
    `Create ${to}`,
    ...(fstabChanges.length ? ["Update /etc/fstab"] : []),
    `Mount the drive at ${to}`,
    ...files.map((f) => `Update ${f.path}`),
    ...(gluonRefs.folderGrants + gluonRefs.pins + gluonRefs.trash > 0 ? ["Update Gluon's saved folders"] : []),
    symlink ? `Leave a link at ${from} pointing to ${to}` : `Remove the empty folder ${from}`,
    ...stopping.map((a) => `Start ${a.name}`),
    ...(stopping.length ? [`Check ${listJoin(stopping.map((a) => a.name))} ${stopping.length === 1 ? "is" : "are"} running`] : []),
  ];

  const plan: RenamePlan = {
    hash: "",
    from,
    to,
    device: rec.vol.path,
    uuid: rec.vol.uuid,
    fstype: rec.vol.fstype ?? "",
    diskTitle: `${rec.disk.title}${rec.disk.model ? ` (${rec.disk.model})` : ""}`,
    symlink,
    persist,
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      mode: a.mode,
      willStop: a.willStop,
      restartServices: a.runningServices,
      containers: a.affected.map((c) => ({ name: c.name, running: c.running, paths: c.binds.filter((b) => b.type === "bind" && isWithin(b.source, from)).map((b) => ({ source: b.source, destination: b.destination })) })),
    })),
    files: planFiles,
    fstab: fstabPlan,
    gluonRefs,
    holders,
    warnings,
    blockers,
    steps,
  };
  plan.hash = sha256(
    JSON.stringify({
      from,
      to,
      symlink,
      persist,
      uuid: rec.vol.uuid,
      apps: plan.apps.map((a) => [a.id, a.mode, a.willStop, a.restartServices, a.containers.map((c) => c.name)]),
      files: files.map((f) => [f.path, sha256(f.before), sha256(f.after)]),
      fstab: sha256(s.fstabText),
      fstabAfter: fstabPlan.after,
      blockers,
    }),
  ).slice(0, 16);
  return { plan, from, to, device: rec.vol.path, mountOptions: m.options.filter((o) => !/^(shared|master|propagate_from|unbindable)/.test(o)), apps, files, fstabChanges, fstabHasTarget };
}

// ---------------------------------------------------------------- execute

function composeFailure(e: unknown, verb: string, name: string): AppError {
  if (e instanceof AppError) return e;
  const err = e as { stderr?: string; message?: string; json?: { message?: string } };
  const detail = (err.stderr ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" ") || err.json?.message || err.message || "no details";
  return new AppError("app_failed", `Docker couldn't ${verb} ${name}: ${detail}`, 500);
}

async function stopApp(a: AppWork, from: string, to: string, moved: boolean) {
  try {
    await stopAppInner(a, from, to, moved);
  } catch (e) {
    throw composeFailure(e, "stop", a.name);
  }
}

async function startApp(a: AppWork, from: string, to: string, moved: boolean) {
  try {
    await startAppInner(a, from, to, moved);
  } catch (e) {
    throw composeFailure(e, "start", a.name);
  }
}

async function stopAppInner(a: AppWork, from: string, to: string, moved: boolean) {
  if (a.mode === "compose" && a.project) {
    const p = moved ? movedProject(a.project, from, to) : a.project;
    await compose(p, ["stop"], 5 * 60_000);
  } else {
    for (const id of a.runningIds) {
      await docker()
        .getContainer(id)
        .stop({ t: 30 })
        .catch((e: { statusCode?: number }) => {
          if (e?.statusCode !== 304 && e?.statusCode !== 404) throw e;
        });
    }
  }
}

async function startAppInner(a: AppWork, from: string, to: string, moved: boolean) {
  if (a.mode === "compose" && a.project) {
    if (!a.runningServices.length) return;
    const p = moved ? movedProject(a.project, from, to) : a.project;
    await compose(p, ["up", "-d", ...a.runningServices], 10 * 60_000);
  } else {
    for (const id of a.runningIds) {
      await docker()
        .getContainer(id)
        .start()
        .catch((e: { statusCode?: number }) => {
          if (e?.statusCode !== 304) throw e;
        });
    }
  }
}

function movedProject(p: ComposeProject, from: string, to: string): ComposeProject {
  return { project: p.project, files: p.files.map((f) => movePath(f, from, to)), workingDir: p.workingDir ? movePath(p.workingDir, from, to) : null };
}

async function waitRunning(apps: AppWork[], from: string, allowOld: boolean, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "";
  while (Date.now() < deadline) {
    const list = await docker().listContainers({ all: true });
    const problems: string[] = [];
    let pending = false;
    for (const a of apps) {
      if (a.mode === "compose") {
        for (const svc of a.runningServices) {
          const c = list.find((x) => x.Labels?.["com.docker.compose.project"] === a.id && x.Labels?.["com.docker.compose.service"] === svc);
          if (!c) problems.push(`${a.name} (${svc}) wasn't created`);
          else if (c.State === "restarting" || c.State === "exited" || c.State === "dead") problems.push(`${a.name} (${svc}) is ${c.State}`);
          else if (c.State !== "running") pending = true;
          else if (!allowOld && (c.Mounts ?? []).some((mt) => mt.Type === "bind" && isWithin(mt.Source, from))) problems.push(`${a.name} (${svc}) still uses ${from}`);
        }
      } else {
        for (const id of a.runningIds) {
          const c = list.find((x) => x.Id === id);
          if (!c) problems.push(`${a.name} is gone`);
          else if (c.State !== "running") problems.push(`${a.name} is ${c.State}`);
        }
      }
    }
    if (!problems.length && !pending) {
      // Still up a few seconds later? (Catches apps that exit right after starting.)
      await new Promise((r) => setTimeout(r, 5000));
      const again = await docker().listContainers({ all: true });
      const died = apps.flatMap((a) =>
        a.mode === "compose"
          ? a.runningServices.filter((svc) => {
              const c = again.find((x) => x.Labels?.["com.docker.compose.project"] === a.id && x.Labels?.["com.docker.compose.service"] === svc);
              return !c || c.State !== "running";
            }).map((svc) => `${a.name} (${svc})`)
          : a.runningIds.filter((id) => again.find((x) => x.Id === id)?.State !== "running").map(() => a.name),
      );
      if (!died.length) return;
      lastProblem = `${listJoin(died)} stopped right after starting`;
    } else lastProblem = problems.join("; ");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new AppError("not_running", `${lastProblem || "Apps didn't come up in time"}. Check the app's logs.`, 500);
}

export function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function tsStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Start the rename in the background. Returns the job to follow. */
export async function startRename(user: User, input: RenameInput & { planHash: string }, where: Where): Promise<Job> {
  const release = acquireLock(`renaming ${input.target}`);
  let work: RenameWork;
  try {
    work = await planRename(input);
  } catch (e) {
    release();
    throw e;
  }
  if (work.plan.blockers.length) {
    release();
    throw new AppError("refused", work.plan.blockers[0]!, 409, { blockers: work.plan.blockers });
  }
  if (work.plan.hash !== input.planHash) {
    release();
    throw conflict("Something changed since you reviewed this (an app, a compose file or /etc/fstab). Review the plan again.");
  }
  const { from, to } = work;
  const job = new Job("rename", from, `Rename ${from} to ${to}`, { from, to, symlink: work.plan.symlink, persist: work.plan.persist, plan: work.plan }, user);
  job.plan(work.plan.steps);
  audit(user, { action: "storage.rename.start", target: from, summary: `Started moving ${from} to ${to}`, detail: { jobId: job.id, apps: work.plan.apps.map((a) => a.id), files: work.files.map((f) => f.path) } }, where);
  void runRename(job, work, user, where).finally(release);
  return job;
}

async function runRename(job: Job, w: RenameWork, user: User, where: Where) {
  const { from, to } = w;
  const undo: { label: string; fn: () => Promise<unknown> }[] = [];
  const ts = tsStamp();
  let failedAt = "";
  const stopping = w.apps.filter((a) => a.willStop);
  try {
    cancelUsageUnder(from);

    for (const a of stopping) {
      failedAt = `Stop ${a.name}`;
      await job.step(failedAt, () => stopApp(a, from, to, false));
      undo.push({ label: `Start ${a.name} again`, fn: () => startApp(a, from, to, false) });
    }

    failedAt = `Make sure nothing else is using ${from}`;
    await job.step(failedAt, async () => {
      const { holders } = await findHolders(from);
      if (holders.length) throw new AppError("busy", `It's still in use: ${holders.map((h) => h.label).slice(0, 5).join(" ")}`, 409);
    });

    failedAt = `Unmount ${from}`;
    await job.step(failedAt, async () => {
      try {
        await host("umount", ["--", from], { timeoutMs: 120_000 });
      } catch (e) {
        throw mountError(e, `Couldn't unmount ${from}`);
      }
    });
    undo.push({
      label: `Mount the drive at ${from} again`,
      fn: async () => {
        if (!fs.existsSync(hostPath(from))) await host("mkdir", ["-p", "--", from], { timeoutMs: 10_000 });
        await host("mount", ["-o", w.mountOptions.join(","), "--", w.device, from], { timeoutMs: 60_000 });
      },
    });

    failedAt = `Create ${to}`;
    const created = await job.step(failedAt, async ({ detail }) => {
      const c = await hostMkdirs(to);
      if (!c) detail("It already existed (empty).");
      if (!dirIsEmpty(to)) throw new AppError("not_empty", `${to} isn't empty any more.`, 409);
      return c;
    });
    if (created) undo.push({ label: `Remove ${to}`, fn: () => hostRemoveEmptyDirs(to, created) });

    if (w.fstabChanges.length) {
      failedAt = "Update /etc/fstab";
      const res = await job.step(failedAt, async ({ detail }) => {
        const cur = readFstabText();
        const r = await writeFstab(applyChanges(cur, w.fstabChanges), cur);
        detail(`Backup saved as ${r.backup}.`);
        return r;
      });
      undo.push({ label: "Put /etc/fstab back", fn: () => restoreFstab(res.backup) });
    }

    failedAt = `Mount the drive at ${to}`;
    await job.step(failedAt, async () => {
      try {
        if (w.fstabHasTarget) await host("mount", ["--", to], { timeoutMs: 60_000 });
        else await host("mount", ["-o", w.mountOptions.join(","), "--", w.device, to], { timeoutMs: 60_000 });
      } catch (e) {
        throw mountError(e, `Couldn't mount the drive at ${to}`);
      }
      const mt = mountAt(to);
      if (!mt || (mt.source !== w.device && !mt.source.endsWith(path.posix.basename(w.device)))) throw new AppError("mount_failed", `Something else ended up mounted at ${to}.`, 500);
    });
    undo.push({ label: `Unmount ${to}`, fn: () => host("umount", ["--", to], { timeoutMs: 120_000 }) });

    for (const f of w.files) {
      const live = movePath(f.path, from, to);
      failedAt = `Update ${f.path}`;
      const backup = await job.step(failedAt, async ({ detail }) => {
        const cur = readHostText(live);
        if (cur !== f.before) throw conflict(`${live} was changed by someone else since you reviewed the plan.`);
        const b = backupHostFile(live, ts);
        writeHostTextAtomic(live, f.after);
        detail(`Backup saved as ${b}.`);
        return b;
      });
      undo.push({ label: `Restore ${live}`, fn: async () => restoreHostFile(live, backup) });
    }

    if (w.plan.gluonRefs.folderGrants + w.plan.gluonRefs.pins + w.plan.gluonRefs.trash > 0) {
      failedAt = "Update Gluon's saved folders";
      await job.step(failedAt, async () => moveGluonRefs(from, to));
      undo.push({ label: "Put Gluon's saved folders back", fn: async () => moveGluonRefs(to, from) });
    }

    if (w.plan.symlink) {
      failedAt = `Leave a link at ${from} pointing to ${to}`;
      const made = await job.step(failedAt, async ({ detail }) => {
        if (fs.existsSync(hostPath(from))) {
          if (!dirIsEmpty(from)) {
            detail(`${from} has files in it that were hidden under the drive, so no link was made. Look inside it.`);
            return false;
          }
          await host("rmdir", ["--", from], { timeoutMs: 10_000 });
        }
        await host("ln", ["-s", "--", to, from], { timeoutMs: 10_000 });
        return true;
      });
      if (made) {
        undo.push({
          label: `Remove the link at ${from}`,
          fn: async () => {
            if (fs.lstatSync(hostPath(from)).isSymbolicLink()) await host("rm", ["-f", "--", from], { timeoutMs: 10_000 });
            await host("mkdir", ["-p", "--", from], { timeoutMs: 10_000 });
          },
        });
      }
    } else {
      failedAt = `Remove the empty folder ${from}`;
      const removed = await job.step(failedAt, async ({ detail }) => {
        if (!fs.existsSync(hostPath(from))) return false;
        if (!dirIsEmpty(from)) {
          detail(`${from} has files in it that were hidden under the drive, so it was left alone. Look inside it.`);
          return false;
        }
        await host("rmdir", ["--", from], { timeoutMs: 10_000 });
        return true;
      });
      if (removed) undo.push({ label: `Recreate ${from}`, fn: () => host("mkdir", ["-p", "--", from], { timeoutMs: 10_000 }) });
    }

    for (const a of stopping) {
      failedAt = `Start ${a.name}`;
      undo.push({ label: `Stop ${a.name}`, fn: () => stopApp(a, from, to, true) });
      await job.step(failedAt, () => startApp(a, from, to, true));
    }

    if (stopping.length) {
      failedAt = `Check ${listJoin(stopping.map((a) => a.name))} ${stopping.length === 1 ? "is" : "are"} running`;
      await job.step(failedAt, () => waitRunning(stopping, from, w.plan.symlink));
    }

    const message = `${from} is now ${to}.${stopping.length ? ` ${listJoin(stopping.map((a) => a.name))} ${stopping.length === 1 ? "was" : "were"} restarted with the new path.` : ""}${w.plan.symlink ? ` ${from} still works as a link.` : ""}`;
    job.finish("done", { result: { from, to, message } });
    audit(user, { action: "storage.rename", target: to, summary: `Moved ${from} to ${to}`, detail: { jobId: job.id, apps: stopping.map((a) => a.id), files: w.files.map((f) => f.path), symlink: w.plan.symlink } }, where);
  } catch (e) {
    const reason = sentence((e as Error).message || "it didn't work");
    const failures: string[] = [];
    for (const u of undo.reverse()) {
      try {
        await job.step(u.label, u.fn, { undo: true });
      } catch (err) {
        failures.push(`${u.label}: ${(err as Error).message}`);
      }
    }
    const message = failures.length
      ? `Moving ${from} stopped at "${failedAt}": ${reason} Gluon tried to put everything back, but some of it needs you: ${failures.join("; ")}.`
      : `Moving ${from} stopped at "${failedAt}": ${reason} Everything was put back the way it was.`;
    job.finish(failures.length ? "failed" : "rolled-back", { error: message });
    audit(user, { action: "storage.rename", target: from, summary: `Tried to move ${from} to ${to}`, detail: { jobId: job.id, failedAt, error: reason, undoFailures: failures }, outcome: "failed" }, where);
    if (failures.length) {
      raise({
        id: `storage.job:${job.id}`,
        kind: "storage.job",
        severity: "fault",
        subject: from,
        title: `Moving ${from} didn't finish cleanly`,
        cause: `It stopped at "${failedAt}" and Gluon couldn't undo everything: ${failures.join("; ")}.`,
        detail: { jobId: job.id },
        remedy: { action: "", label: "See what happened", href: `/storage?job=${job.id}` },
      });
    }
  } finally {
    afterChange();
    invalidateApps();
    publish("apps.changed", { storage: true });
  }
}
