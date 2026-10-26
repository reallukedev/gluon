import "server-only";
import fs from "node:fs";
import YAML from "yaml";
import type { UninstallItem, UninstallPlan } from "@/lib/app-move-types";
import { uninstallBlock } from "@/lib/app-move-types";
import { docker } from "../docker/client";
import { getApp, invalidateApps, listApps, type AppSummary } from "../docker/apps";
import { composeReferences } from "./refs";
import { parseEnvFile } from "./vars";
import { host } from "../host/exec";
import { hostExists, hostPath } from "../host/paths";
import { AppError, conflict, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import type { User } from "../auth/users";
import { appsRoots } from "./root";
import { inspectAll, mountsOf, readText, sizeOf, volumeInfo } from "./facts";
import { buildUninstallPlan, deletable, type UninstallInput } from "./uninstall-plan";
import { isBroadPath } from "./paths";
import path from "node:path";
import { lockApps } from "./lock";
import { bindUses } from "./facts";
import { norm, usersOf, type BindUse } from "./paths";

type Where = { ip?: string; zone?: string };

async function gather(app: AppSummary): Promise<UninstallInput> {
  const block = uninstallBlock(app);
  if (block) throw new AppError("cant_uninstall", block, 409);
  const project = app.configFile ? app.id : null;
  const [inspects, list, { roots }, labelled] = await Promise.all([
    inspectAll(app.containers.map((c) => c.id)),
    docker().listContainers({ all: true }),
    appsRoots(),
    // Compose labels the volumes it creates with the project name; only those count as the project's.
    project ? docker().listVolumes({ filters: { label: [`com.docker.compose.project=${project}`] } }).then((r) => new Set((r.Volumes ?? []).map((v) => v.Name))) : Promise.resolve(new Set<string>()),
  ]);
  const volumes = await volumeInfo(list);
  const configFiles = app.configFile ? app.configFile.split(",") : [];
  const projectVolumes = volumes.filter((v) => labelled.has(v.name));
  const source: UninstallPlan["source"] = app.source === "gluon" ? "gluon" : app.source === "casaos" && app.configFile ? "casaos" : app.source === "compose" && app.configFile ? "compose" : "docker";
  const casaDataDirs: string[] = [];
  if (source === "casaos") {
    let storeId: string | null = null;
    try {
      const x = (YAML.parse(readText(configFiles[0]!) ?? "") as Record<string, unknown>)?.["x-casaos"] as Record<string, unknown> | undefined;
      storeId = typeof x?.store_app_id === "string" ? x.store_app_id : null;
    } catch {
      /* no metadata */
    }
    for (const n of new Set([app.id, storeId].filter(Boolean) as string[])) if (/^[A-Za-z0-9._-]+$/.test(n) && hostExists(`/DATA/AppData/${n}`)) casaDataDirs.push(`/DATA/AppData/${n}`);
  }
  const folder = app.gluon?.folder ?? null;
  return {
    appId: app.id,
    name: app.name,
    source,
    project,
    configFiles,
    workingDir: app.workingDir,
    containers: inspects.map((i) => ({ name: i.Name.replace(/^\//, ""), mounts: mountsOf(i) })),
    projectVolumes,
    volumes,
    binds: [...bindUses(list), ...(await referencedByOthers(app))],
    gluonFolder: folder,
    appsRoots: roots,
    runFiles: folder ? ["docker-compose.yml", ".env", ".gluon-app"].filter((f) => hostExists(`${folder}/${f}`)) : [],
    casaDataDirs,
    sizes: new Map(),
  };
}

/** Paths other Gluon, Compose and CasaOS apps' compose files point at, as if they were mounts. */
async function referencedByOthers(app: AppSummary): Promise<{ source: string; container: string }[]> {
  const out: { source: string; container: string }[] = [];
  for (const other of await listApps()) {
    if (other.id === app.id || !other.configFile) continue;
    const file = other.configFile.split(",")[0]!;
    const text = readText(file);
    if (text === null) continue;
    const dir = other.workingDir ?? path.posix.dirname(file);
    const env = parseEnvFile(readText(`${dir}/.env`) ?? "");
    for (const source of composeReferences(text, dir, env)) out.push({ source, container: other.name });
  }
  return out;
}

async function plan(app: AppSummary): Promise<UninstallPlan> {
  const input = await gather(app);
  const first = buildUninstallPlan(input);
  const targets = new Set<string>();
  for (const m of [first.keep, first.everything]) for (const i of [...m.removes, ...m.keeps]) if (i.kind !== "file" && !i.note?.startsWith("Used in place")) targets.add(i.kind === "volume" ? `volume:${i.target}` : i.target);
  const sizes = new Map<string, number | null>();
  await Promise.all(
    [...targets].map(async (t) => {
      const p = t.startsWith("volume:") ? input.volumes.find((v) => v.name === t.slice(7))?.mountpoint : t;
      sizes.set(t, p ? await sizeOf(p, 30_000) : null);
    }),
  );
  return buildUninstallPlan({ ...input, sizes });
}

export async function uninstallPlan(id: string): Promise<UninstallPlan> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  return plan(app);
}

export async function runUninstall(id: string, mode: "keep" | "everything", planId: string, user: User, where: Where, picked?: string[]): Promise<{ message: string; failed: string[] }> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  // Held for the whole uninstall: no move, start or update of this app can run alongside.
  const lock = lockApps([app.id], `${app.name} is being uninstalled`);
  try {
    return await uninstallLocked(app, mode, planId, user, where, picked);
  } finally {
    lock.release();
  }
}

async function uninstallLocked(app: AppSummary, mode: "keep" | "everything", planId: string, user: User, where: Where, picked?: string[]): Promise<{ message: string; failed: string[] }> {
  const id = app.id;
  // The plan id leaves sizes out, so there's no need to measure everything again here.
  const p = buildUninstallPlan(await gather(app));
  if (p.id !== planId) throw conflict(`Something about ${app.name} changed since you opened this. Check the list again.`);
  const chosen = mode === "everything" ? { ...p.everything, removes: pickRemovals(p.everything, picked) } : p.keep;

  // Containers first: nothing is deleted unless they're gone.
  if (p.via === "compose" && app.configFile) {
    await host("docker", ["compose", "-p", app.id, ...app.configFile.split(",").flatMap((f) => ["-f", f]), "down", "--remove-orphans"], { timeoutMs: 5 * 60_000 });
  } else {
    for (const c of app.containers) {
      const ctr = docker().getContainer(c.id);
      await ctr.stop({ t: 30 }).catch((e: { statusCode?: number }) => {
        if (e?.statusCode !== 304 && e?.statusCode !== 404) throw e;
      });
      await ctr.remove({ v: false }).catch((e: { statusCode?: number }) => {
        if (e?.statusCode !== 404) throw e;
      });
    }
  }

  const failed: string[] = [];
  const deleted: string[] = [];
  const own = [...p.everything.removes, ...p.everything.optional].filter((i) => i.kind === "folder").map((i) => i.target);
  // Asked again right before deleting: a container that started using a folder since the plan keeps it.
  const binds = bindUses(await docker().listContainers({ all: true }));
  const mine = new Set(p.containers);
  for (const item of chosen.removes) {
    try {
      await remove(item, own, binds, mine);
      deleted.push(item.target);
    } catch (e) {
      failed.push(`${item.target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (p.source === "gluon" && mode === "keep" && app.gluon) {
    try {
      fs.rmdirSync(hostPath(app.gluon.folder)); // only succeeds when nothing is left in it
    } catch {
      /* data stays */
    }
  }
  invalidateApps();
  publish("apps.changed", { id });
  const kept = chosen.keeps.filter((k) => k.kind !== "volume" || !deleted.includes(k.target));
  audit(
    user,
    {
      action: "app.uninstall",
      target: id,
      summary: mode === "everything" ? `Uninstalled ${app.name} and deleted its data` : `Uninstalled ${app.name}, keeping its data`,
      detail: { mode, containers: p.containers, deleted, kept: kept.map((k) => k.target), failed },
      outcome: failed.length ? "failed" : "ok",
    },
    where,
  );
  const message = failed.length
    ? `${app.name} is uninstalled, but Gluon couldn't delete ${failed.length === 1 ? "one item" : `${failed.length} items`}. Activity has the details.`
    : mode === "everything"
      ? `${app.name} is uninstalled and its data is deleted.`
      : `${app.name} is uninstalled. Its data is still on disk.`;
  return { message, failed };
}

/**
 * What "delete everything" deletes: what the person ticked (when the dialog says), else the
 * default list. Only ever things the plan says may go; folders ticked by hand must be optional ones.
 */
export function pickRemovals(m: UninstallPlan["everything"], picked: string[] | undefined): UninstallItem[] {
  if (!picked) return m.removes;
  const want = new Set(picked);
  return [...m.removes, ...m.optional].filter((i) => want.has(i.target));
}

async function remove(item: UninstallItem, own: string[], binds: BindUse[], mine: Set<string>) {
  if (item.kind === "volume") {
    await docker().getVolume(item.target).remove();
    return;
  }
  // The plan only lists paths inside the app's own folders; check once more right before deleting.
  const t = norm(item.target);
  if (!t || t !== item.target) throw new Error("not a plain path");
  const ok = item.kind === "file" ? own.some((o) => deletable(t, o)) : (own.includes(t) || path.posix.dirname(t) === "/var/lib/casaos/apps") && !isBroadPath(t);
  if (!ok) throw new Error("not inside the app's own folder");
  const who = usersOf(t, binds, mine);
  if (who.length) throw new Error(`now also used by ${who.join(", ")}, so it was kept`);
  if (item.kind === "file") fs.rmSync(hostPath(t), { force: true });
  else await host("rm", ["-rf", "--one-file-system", "--", t], { timeoutMs: 60 * 60_000 });
}
