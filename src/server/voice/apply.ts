import "server-only";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { hostPath } from "../host/paths";
import { hostListeners } from "../network/sockets";
import { listApps } from "../docker/apps";
import { readCompose, applyCompose } from "../docker/compose";
import { withAppLock } from "../apps/lock";
import { AppError } from "../errors";
import { appDetail, saveDraft, startPublish } from "../appstore/service";
import { currentJob, type Emit } from "../appstore/jobs";
import type { User } from "../auth/users";
import { ENV_FILE, mumbleService } from "./compose-edit";
import type { MumbleFacts } from "./container";
import type { ManageOption } from "./types";

/**
 * Changing how a Mumble app runs, for the two kinds of app Gluon can change:
 * - builder apps: the compose file is generated from the builder's spec on every publish, so the
 *   spec (and the builder's secret store) is changed and the app republished;
 * - compose apps: the compose file is edited and applied the way the Compose tab does it, with a
 *   backup and an automatic roll-back if it doesn't come up.
 */

type Where = { ip?: string; zone?: string };

export type ChangeTarget =
  | { via: "builder"; builderId: string; service: string }
  | { via: "compose"; service: string; file: string; dir: string };

export async function changeTarget(f: MumbleFacts): Promise<{ target: ChangeTarget | null; option: ManageOption }> {
  const app = f.app;
  const no = (why: string) => ({ target: null, option: { ok: false, via: null, why } satisfies ManageOption });
  if (app.umbrel) return no("Umbrel rewrites this app's files when it updates. Move it to Gluon first (Settings tab), then Gluon can manage it.");
  if (app.self) return no("This is Gluon itself.");
  const builderId = app.gluon?.builderId ?? null;
  if (builderId) {
    try {
      const d = await appDetail(builderId);
      if (d.status !== "published" || d.target !== "compose") return no("This app isn't published by Gluon's builder any more.");
      const service = mumbleService(d.spec.compose);
      if (!service) return no("Gluon can't find the Mumble service in this app's builder settings.");
      return { target: { via: "builder", builderId, service }, option: { ok: true, via: "builder", why: null } };
    } catch {
      return no("Gluon's builder doesn't know this app any more.");
    }
  }
  if (!app.configFile) return no("This app wasn't started with Docker Compose, so there's no file Gluon can change.");
  if (app.configFile.includes(",")) return no("This app is made from several compose files. Change it in the Compose tab.");
  const file = app.configFile;
  let text: string;
  try {
    text = fs.readFileSync(hostPath(file), "utf8");
  } catch {
    return no(`Gluon can't read ${file}.`);
  }
  const service = mumbleService(text) ?? f.service;
  if (!service) return no("Gluon can't find the Mumble service in the compose file.");
  return { target: { via: "compose", service, file, dir: path.posix.dirname(file) }, option: { ok: true, via: "compose", why: null } };
}

/** A free port on this server's loopback for Ice, starting at 6502. */
export async function freeIcePort(start = 6502): Promise<number> {
  const used = new Set<number>();
  for (const l of await hostListeners().catch(() => [])) if (l.proto === "tcp" && l.local.port) used.add(l.local.port);
  for (const a of await listApps().catch(() => [])) for (const c of a.containers) for (const p of c.ports) if (p.proto === "tcp") used.add(p.host);
  for (let p = start; p < start + 200; p++) {
    if (used.has(p)) continue;
    if (await canBind(p)) return p;
  }
  throw new AppError("no_port", "Gluon couldn't find a free port for Mumble's admin connection.", 409);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export interface Change {
  /** New compose text from the current one (the builder's spec compose, or the file). */
  compose: (text: string, service: string) => string;
  /** Builder apps: secret variables to set and remove for the Mumble service. */
  secrets?: { set?: Record<string, string>; remove?: string[] };
  /** Compose apps: a private file next to the compose file. */
  envFile?: string;
  /** What to call it in the activity log and the progress. */
  label: string;
}

/** Make the change and bring the app back up. Throws AppError with what went wrong. */
export async function applyChange(target: ChangeTarget, appId: string, change: Change, user: User, where: Where, emit: Emit): Promise<void> {
  if (target.via === "builder") {
    const d = await appDetail(target.builderId);
    const compose = change.compose(d.spec.compose, target.service);
    const existing = d.secrets[target.service] ?? [];
    const remove = (change.secrets?.remove ?? []).filter((k) => existing.includes(k));
    saveDraft(target.builderId, {
      rev: d.rev,
      spec: { ...d.spec, compose },
      secrets: {
        ...(change.secrets?.set ? { set: { [target.service]: change.secrets.set } } : {}),
        ...(remove.length ? { remove: { [target.service]: remove } } : {}),
      },
    });
    emit({ type: "step", text: "Saved the change in the app's builder settings" });
    await startPublish(target.builderId, user, where);
    await follow(target.builderId, emit);
    return;
  }

  const file = await readCompose(appId);
  const next = change.compose(file.content, target.service);
  if (change.envFile !== undefined) {
    const p = `${target.dir}/${ENV_FILE}`;
    const st = fs.statSync(hostPath(file.path));
    const tmp = `${hostPath(p)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, change.envFile, { mode: 0o600 });
    try {
      fs.chownSync(tmp, st.uid, st.gid);
    } catch {
      /* keep the current owner */
    }
    fs.renameSync(tmp, hostPath(p));
    emit({ type: "step", text: `Wrote Ice's secrets to ${ENV_FILE}, readable only by its owner` });
  }
  let result: { ok: boolean; message: string } | null = null;
  await withAppLock([appId], "its voice server is being changed", () =>
    applyCompose(appId, next, file.hash, (e) => {
      if (e.type === "done") result = { ok: e.ok, message: e.message };
      else if (e.type === "step") emit({ type: "step", text: e.text });
      else emit({ type: "line", text: e.text, stream: e.stream });
    }),
  );
  const r = result as { ok: boolean; message: string } | null;
  if (!r?.ok) throw new AppError("apply_failed", r?.message ?? "The change didn't apply.", 500);
}

/** Forward a builder publish's progress until it ends. */
async function follow(builderId: string, emit: Emit) {
  // Snapshots hold the last 400 events, so remember the last one forwarded rather than a count.
  let last: unknown = null;
  for (;;) {
    const job = currentJob(builderId);
    if (!job) throw new AppError("publish_lost", "Gluon lost track of the publish. Check the app's builder page.", 500);
    const from = last ? job.events.indexOf(last as (typeof job.events)[number]) + 1 : 0;
    for (const e of job.events.slice(from)) {
      if (e.type === "step" || e.type === "line" || e.type === "progress") emit(e);
    }
    last = job.events.at(-1) ?? last;
    if (job.finishedAt) {
      const done = job.events.findLast((e) => e.type === "done");
      if (!job.ok) throw new AppError("publish_failed", done?.message ?? "Publishing the change didn't work.", 500, { lines: done?.detail ?? [] });
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}
