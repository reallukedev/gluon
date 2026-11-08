import "server-only";
import fs from "node:fs";
import path from "node:path";
import { all, now, one, run } from "../db";
import { host } from "../host/exec";
import { hostPath } from "../host/paths";
import { getSetting } from "../settings";
import { audit, systemEvent } from "../audit";
import { raise, resolve } from "../findings";
import { publish } from "../events";
import { onStart, every } from "../jobs";
import { umbrelAction } from "../platform/umbrel";
import { AppError } from "../errors";
import type { User } from "../auth/users";
import { CHANNEL_NAME, type GithubTarget, type UpdateChannel, type UpdateLog, type UpdateMethod, type UpdateOption, type UpdateRelation, type UpdateRun, type UpdateStage, type UpdatesStatus } from "@/lib/updates-types";
import { REPO, changesSince, detectInstall, latestOnGithub, relate, runningBuild, umbrelStoreVersion, type InstallDetail } from "./source";

/**
 * From GitHub, the update builds here and runs as a transient systemd unit on the host
 * (docker/gluon-update.sh), so it carries on while this container is replaced and rolls back if the
 * new one isn't healthy. From a store, Umbrel or Compose does the update; Gluon never publishes to a
 * store.
 */

const DIR = "/var/lib/gluon";
const SCRIPT = `${DIR}/gluon-update.sh`;
const unitName = (id: string) => `gluon-update-${id}`;

interface Check {
  at: number;
  channel: UpdateChannel;
  latest: GithubTarget | null;
  error: string | null;
}

type G = typeof globalThis & {
  __gluonUpdateCheck?: Check;
  __gluonUpdateChecking?: { channel: UpdateChannel; promise: Promise<Check> };
  __gluonUpdateWatch?: ReturnType<typeof setInterval> | null;
  __gluonUpdateStarting?: boolean;
};
const g = globalThis as G;

interface Row {
  id: string;
  method: UpdateMethod;
  from_version: string;
  to_version: string;
  ref: string | null;
  started_at: number;
  finished_at: number | null;
  outcome: "running" | "ok" | "failed";
  stage: UpdateStage | null;
  message: string | null;
  auto: number;
  username: string | null;
  log: string;
}

const toRun = (r: Row): UpdateRun => ({
  id: r.id,
  method: r.method,
  fromVersion: r.from_version,
  toVersion: r.to_version,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  stage: r.stage,
  message: r.message,
  auto: !!r.auto,
  username: r.username,
});

/**
 * Nightly's is just under the half-hour the background job runs at, so each run asks GitHub again,
 * well under the 60 an hour it allows.
 */
const FRESH: Record<UpdateChannel, number> = { stable: 6 * 3600_000, nightly: 28 * 60_000 };
const FAILED_FRESH = 25 * 60_000;

export async function check(force = false): Promise<Check> {
  const channel = getSetting("updates").channel;
  const inflight = g.__gluonUpdateChecking;
  if (inflight && inflight.channel === channel) return inflight.promise;
  const c = g.__gluonUpdateCheck;
  if (!force && c && c.channel === channel && Date.now() - c.at < (c.error ? FAILED_FRESH : FRESH[channel])) return c;
  const promise: Promise<Check> = (async () => {
    let latest: GithubTarget | null = null;
    let error: string | null = null;
    try {
      latest = await latestOnGithub(channel);
      if (!latest) error = channel === "stable" ? "No releases have been published on GitHub yet." : "GitHub has no commits on main.";
      else if (channel === "nightly") latest = { ...latest, since: await changesSince(runningBuild().commit, latest) };
    } catch (e) {
      error = (e as Error).message || "The check didn't finish.";
    }
    const result: Check = { at: Date.now(), channel, latest, error };
    // A channel switch while GitHub was answering wins: don't file this under the new channel.
    if (getSetting("updates").channel === channel) g.__gluonUpdateCheck = result;
    return result;
  })().finally(() => {
    if (g.__gluonUpdateChecking?.promise === promise) g.__gluonUpdateChecking = undefined;
  });
  g.__gluonUpdateChecking = { channel, promise };
  return promise;
}

export function forgetCheck() {
  g.__gluonUpdateCheck = undefined;
  g.__gluonUpdateChecking = undefined;
}

const canSwapKind = (kind: InstallDetail["install"]["kind"]) => kind === "umbrel" || kind === "compose" || kind === "casaos";

/** `offered`: the version Umbrel's app store offers (asked for alongside GitHub; null when not on Umbrel). */
function options(detail: InstallDetail, latest: GithubTarget | null, relation: UpdateRelation | null, offered: string | null): UpdateOption[] {
  const out: UpdateOption[] = [];
  const kind = detail.install.kind;
  const newer = relation === "newer";
  const why =
    kind === "development"
      ? "It runs from its source folder, so update it with git. Installed copies update from here."
      : kind === "docker"
        ? "Gluon was started with docker run, so it can't recreate its own container. Run it with Docker Compose to update from here."
        : kind === "unknown"
          ? "Can't find Gluon's own container, so the update has nothing to replace."
          : !latest
            ? "Nothing to download yet."
            : relation === "ahead"
              ? `You're on a build ahead of ${latest.version}.`
              : !newer
                ? "You're on the newest version."
                : null;
  const what = latest ? (latest.channel === "nightly" ? `nightly ${latest.version}` : latest.version) : null;
  out.push({
    method: "github",
    label: what ? `Download ${what} from GitHub and build it on this server (a few minutes).` : "Download from GitHub and build it on this server.",
    available: canSwapKind(kind) && !!latest && newer,
    reason: why,
    target: latest,
    storeVersion: null,
  });
  if (detail.install.kind === "umbrel") {
    const installed = detail.install.storeVersion;
    const has = !!offered && offered !== installed;
    out.push({
      method: "umbrel",
      label: has ? `Update through Umbrel to ${offered}, the version its app store offers.` : "Update through Umbrel's app store.",
      available: has,
      reason: has ? null : offered ? "Umbrel's app store has nothing newer." : "Umbrel's app store doesn't list Gluon.",
      target: null,
      storeVersion: offered,
    });
  }
  if (detail.install.kind === "casaos") {
    const local = !detail.install.image.includes("/") || detail.install.image.startsWith("gluon:");
    out.push({
      method: "casaos",
      label: `Pull the newest ${detail.install.image} and restart, the way CasaOS updates apps.`,
      available: !local,
      reason: local ? "This copy was built on the server, not pulled from a registry, so there's nothing to pull." : null,
      target: null,
      storeVersion: null,
    });
  }
  return out;
}

/** The status, plus whether "newer" is certain (automatic updates never act on a guess). */
async function evaluate(force = false): Promise<{ status: UpdatesStatus; certain: boolean }> {
  await watch();
  const install = detectInstall();
  // What Umbrel's store offers depends only on how Gluon is installed: ask it while GitHub answers.
  const store = install.then((d) => (d.install.kind === "umbrel" ? umbrelStoreVersion(d.install.appId) : null)).catch(() => null);
  const [detail, c] = await Promise.all([install, check(force)]);
  const running = runningBuild();
  const settings = getSetting("updates");
  const latest = c.channel === settings.channel ? c.latest : null;
  const rel = latest ? await relate(latest, running, settings.channel) : null;
  const relation = rel?.relation ?? null;
  const canSelfUpdate = canSwapKind(detail.install.kind);
  const current = one<Row>("SELECT * FROM self_updates WHERE outcome = 'running' ORDER BY started_at DESC LIMIT 1");
  return {
    certain: rel?.certain ?? true,
    status: {
      running,
      install: detail.install,
      repo: REPO,
      settings,
      checkedAt: c.at,
      checkError: c.error,
      latest,
      relation,
      updateAvailable: relation === "newer",
      goBack: settings.channel === "stable" && relation === "ahead" && canSelfUpdate && latest ? latest : null,
      canSelfUpdate,
      options: options(detail, latest, relation, await store),
      current: current ? toRun(current) : null,
      recent: all<Row>("SELECT * FROM self_updates ORDER BY started_at DESC LIMIT 8").map(toRun),
    },
  };
}

export async function status(force = false): Promise<UpdatesStatus> {
  return (await evaluate(force)).status;
}

function readLog(file: string): string[] {
  try {
    return fs.readFileSync(hostPath(file), "utf8").split("\n").filter(Boolean).slice(-400);
  } catch {
    return [];
  }
}

function refresh(r: Row): Row {
  if (r.outcome !== "running" || r.method === "umbrel") return r;
  const lines = readLog(r.log);
  let stage = r.stage;
  let done: { ok: boolean; message: string } | null = null;
  for (const l of lines) {
    const s = l.match(/^::stage (\w+)/);
    if (s) stage = s[1] as UpdateStage;
    const d = l.match(/^::done (ok|failed) (.*)$/);
    if (d) done = { ok: d[1] === "ok", message: d[2]! };
  }
  if (done) {
    run("UPDATE self_updates SET outcome = ?, stage = ?, message = ?, finished_at = ? WHERE id = ?", done.ok ? "ok" : "failed", stage, done.message, now(), r.id);
    systemEvent({ action: "gluon.update", target: "gluon", summary: done.ok ? `Gluon updated to ${r.to_version}` : `Gluon's update to ${r.to_version} failed: ${done.message}`, outcome: done.ok ? "ok" : "failed" });
  } else if (stage !== r.stage) {
    run("UPDATE self_updates SET stage = ? WHERE id = ?", stage, r.id);
  }
  return one<Row>("SELECT * FROM self_updates WHERE id = ?", r.id) ?? r;
}

/** null when systemd can't be asked. */
async function unitState(id: string): Promise<"running" | "gone" | null> {
  try {
    const { stdout } = await host("systemctl", ["is-active", `${unitName(id)}.service`], { timeoutMs: 5000, okCodes: [1, 3, 4] });
    const st = stdout.trim();
    if (st === "active" || st === "activating" || st === "deactivating" || st === "reloading") return "running";
    if (st === "inactive" || st === "failed") return "gone";
    return null;
  } catch {
    return null;
  }
}

async function watch() {
  const active = all<Row>("SELECT * FROM self_updates WHERE outcome = 'running'");
  for (const r of active) {
    const running = runningBuild();
    // Store updates and swaps that finished while this process was being replaced: judge by what's running now.
    if (r.method === "umbrel" && (running.build === r.to_version || running.version === r.to_version)) {
      run("UPDATE self_updates SET outcome = 'ok', message = ?, finished_at = ? WHERE id = ?", `Gluon ${r.to_version} is running.`, now(), r.id);
      continue;
    }
    // Asked before the log is read: a unit that ends in between has written its last line by then.
    const unit = r.method === "umbrel" ? null : await unitState(r.id);
    const fresh = refresh(r);
    if (fresh.outcome !== "running") continue;
    const age = now() - fresh.started_at;
    if (unit === "gone" && age > 60_000) {
      // The updater ended (or the server restarted) without saying how it went.
      run("UPDATE self_updates SET outcome = 'failed', message = ?, finished_at = ? WHERE id = ?", "The updater stopped before it said how it went. Its output shows how far it got.", now(), r.id);
    } else if (age > (unit === "running" ? 4 : 1) * 60 * 60_000) {
      // A slow build on a small server can run past an hour; one still going after four has hung.
      run("UPDATE self_updates SET outcome = 'failed', message = ?, finished_at = ? WHERE id = ?", unit === "running" ? "The update hasn't finished after four hours." : "The update didn't report back within an hour.", now(), r.id);
    }
  }
  const still = one<{ n: number }>("SELECT COUNT(*) AS n FROM self_updates WHERE outcome = 'running'")!.n;
  if (still && !g.__gluonUpdateWatch) {
    g.__gluonUpdateWatch = setInterval(() => {
      void watch().then(() => publish("updates", { at: Date.now() }));
    }, 3000);
    g.__gluonUpdateWatch.unref?.();
  } else if (!still && g.__gluonUpdateWatch) {
    clearInterval(g.__gluonUpdateWatch);
    g.__gluonUpdateWatch = null;
  }
}

export function runLog(id: string): UpdateLog {
  const r = one<Row>("SELECT * FROM self_updates WHERE id = ?", id);
  if (!r) throw new AppError("not_found", "That update isn't in the history.", 404);
  const fresh = refresh(r);
  return { run: toRun(fresh), lines: r.method === "umbrel" ? [] : readLog(r.log).filter((l) => !l.startsWith("::")) };
}

function installScript() {
  const candidates = [path.join(process.cwd(), "gluon-update.sh"), path.join(process.cwd(), "docker", "gluon-update.sh")];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) throw new AppError("updater_missing", "This copy of Gluon doesn't include its updater.", 500);
  fs.mkdirSync(hostPath(DIR), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, hostPath(SCRIPT));
  fs.chmodSync(hostPath(SCRIPT), 0o700);
}

export async function startUpdate(opts: {
  method: UpdateMethod;
  user: User | null;
  auto: boolean;
  /** Going back to the newest release from a build ahead of it (Nightly → Stable). Only ever from a person. */
  allowOlder?: boolean;
  where?: { ip: string; zone: string };
}): Promise<UpdateRun> {
  // Claimed before any await: the running row is only written after slow GitHub calls, and a
  // manual Apply and the automatic check must not both get through in that gap.
  if (g.__gluonUpdateStarting || one("SELECT id FROM self_updates WHERE outcome = 'running'")) throw new AppError("busy", "An update is already running.", 409);
  g.__gluonUpdateStarting = true;
  try {
    return await startUpdateClaimed(opts);
  } finally {
    g.__gluonUpdateStarting = false;
  }
}

async function startUpdateClaimed(opts: Parameters<typeof startUpdate>[0]): Promise<UpdateRun> {
  await watch();
  if (one("SELECT id FROM self_updates WHERE outcome = 'running'")) throw new AppError("busy", "An update is already running.", 409);
  const s = await status(true);
  const back = opts.allowOlder && !opts.auto && opts.method === "github" ? s.goBack : null;
  const opt = s.options.find((o) => o.method === opts.method);
  if (opts.allowOlder && opts.method !== "github") throw new AppError("bad_request", "Only an update from GitHub can go back to an older version.", 400);
  if (!back && !opt?.available) throw new AppError("unavailable", opt?.reason ?? "That kind of update isn't possible here.", 409);
  const target = back ?? opt?.target ?? null;
  if (opts.method === "github" && !target) throw new AppError("unavailable", "Nothing to download yet.", 409);
  const detail = await detectInstall();
  const id = Math.random().toString(36).slice(2, 10);
  const log = `${DIR}/update-${id}.log`;
  const short = s.running.commit?.slice(0, 7);
  const from = s.running.version + (short && !s.running.version.includes(short) ? ` (${short})` : "");
  const to = opts.method === "github" ? target!.version : (opt?.storeVersion ?? "newest");

  run(
    "INSERT INTO self_updates (id, method, from_version, to_version, ref, started_at, outcome, stage, auto, user_id, username, log) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
    id,
    opts.method,
    from,
    to,
    opts.method === "github" ? target!.ref : null,
    now(),
    opts.method === "umbrel" ? "apply" : "download",
    opts.auto ? 1 : 0,
    opts.user?.id ?? null,
    opts.user?.username ?? null,
    log,
  );

  try {
    if (opts.method === "umbrel") {
      if (detail.install.kind !== "umbrel") throw new Error("Gluon isn't installed through Umbrel.");
      await umbrelAction(detail.install.appId, "update");
    } else {
      installScript();
      let args: string[];
      const modeArgs = (): string[] => {
        if (detail.umbrel && detail.container) return ["umbrel", detail.umbrel.appId, detail.umbrel.appDataDir, detail.umbrel.umbrelContainer ?? "-", detail.container.name];
        if (detail.compose && detail.container)
          return ["compose", detail.compose.workdir, detail.compose.project, detail.compose.service, detail.compose.image, detail.container.name, detail.compose.configFiles.join(",")];
        throw new Error("Can't tell how Gluon is installed.");
      };
      if (opts.method === "github") {
        const t = target!;
        // Download the exact commit that was checked, not whatever the tag points at by now.
        if (!/^[0-9a-f]{40}$/.test(t.sha)) throw new AppError("bad_target", "GitHub didn't say which commit this version is. Check for updates again.", 409);
        args = ["github", REPO, t.sha, t.version, t.commit, ...modeArgs()];
      } else {
        args = ["pull", ...modeArgs()];
      }
      await host(
        "systemd-run",
        [
          `--unit=${unitName(id)}`,
          "--description=Gluon: updating itself",
          "--collect",
          `--property=StandardOutput=append:${log}`,
          `--property=StandardError=append:${log}`,
          "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "--",
          "/bin/bash",
          SCRIPT,
          ...args,
        ],
        { timeoutMs: 30_000 },
      );
    }
  } catch (e) {
    const message = (e as Error).message || "Couldn't start the update.";
    run("UPDATE self_updates SET outcome = 'failed', message = ?, finished_at = ? WHERE id = ?", message, now(), id);
    throw new AppError("start_failed", `The update couldn't start: ${message}`, 500);
  }

  const how = opts.method === "github" ? "from GitHub" : opts.method === "umbrel" ? "through Umbrel" : "by pulling the newest image";
  const summary = back
    ? `Started moving Gluon back to ${to}, the newest Stable release (${how})`
    : `${opts.auto ? "Started an automatic update" : "Started updating Gluon"} to ${target?.channel === "nightly" && opts.method === "github" ? `nightly ${to}` : to} (${how})`;
  const detailInfo = { method: opts.method, from, to, channel: s.settings.channel, ...(back ? { olderRelease: true } : {}) };
  if (opts.user) audit(opts.user, { action: "gluon.update", target: "gluon", summary, detail: detailInfo }, opts.where);
  else systemEvent({ action: "gluon.update", target: "gluon", summary, detail: detailInfo });
  await watch();
  return toRun(one<Row>("SELECT * FROM self_updates WHERE id = ?", id)!);
}

const ASAP_GAP = 45 * 60_000;

/** Nightly "as it lands": not within 45 minutes of the last update, and not again for a build that already failed. */
function asapBlocked(to: string | null): "wait" | "failed" | null {
  const last = one<{ t: number | null }>("SELECT MAX(started_at) AS t FROM self_updates")?.t ?? 0;
  if (now() - last < ASAP_GAP) return "wait";
  if (to && one("SELECT id FROM self_updates WHERE to_version = ? AND outcome = 'failed' AND auto = 1", to)) return "failed";
  return null;
}

async function background(opts: { install?: boolean } = {}) {
  const { status: s, certain } = await evaluate();
  const settings = s.settings;
  const opt = s.options.find((o) => o.method === settings.method) ?? s.options[0];
  const available = s.options.filter((o) => o.available);
  if (!available.length || s.current) {
    resolve("gluon-update");
    return;
  }
  const nightly = settings.channel === "nightly";
  const fromGithub = !!s.latest && available.some((o) => o.method === "github");
  const name = fromGithub && s.latest ? (nightly ? `${CHANNEL_NAME.nightly} ${s.latest.version}` : `Gluon ${s.latest.version}`) : "A newer Gluon";
  let cause = s.latest?.title && s.latest.title !== name ? s.latest.title : "Install it from Settings → Updates, or turn on automatic updates.";

  if (settings.auto && opt?.available) {
    const to = opt.method === "github" ? (opt.target?.version ?? null) : opt.storeVersion;
    if (nightly && settings.nightlyTiming === "asap") {
      const blocked = asapBlocked(to);
      if (blocked !== "failed") {
        // Automatic updates will take it: nothing for a person to do.
        resolve("gluon-update");
        if (!blocked && certain && opts.install !== false) await startAuto(opt.method);
        return;
      }
      cause = "The automatic update to it didn't finish. Gluon will try the next nightly on its own, or you can try this one from Settings → Updates.";
    } else {
      resolve("gluon-update");
      const lastAuto = one<{ t: number | null }>("SELECT MAX(started_at) AS t FROM self_updates WHERE auto = 1")?.t ?? 0;
      if (certain && opts.install !== false && new Date().getHours() === settings.hour && now() - lastAuto > 20 * 3600_000) await startAuto(opt.method);
      return;
    }
  }
  raise({
    id: "gluon-update",
    kind: "gluon-update",
    severity: "info",
    subject: "gluon",
    title: `${name} is available`,
    cause,
    remedy: { action: "", label: "See the update", href: "/settings/updates" },
  });
}

async function startAuto(method: UpdateMethod) {
  await startUpdate({ method, user: null, auto: true }).catch((e) =>
    systemEvent({ action: "gluon.update", target: "gluon", summary: `Automatic update didn't start: ${(e as Error).message}`, outcome: "failed" }),
  );
}

/** Never installs anything. */
export function reconsider() {
  void background({ install: false }).catch(() => undefined);
}

onStart("updates", () => {
  // Finish the books on an update that replaced the previous process.
  setTimeout(() => void watch().catch(() => undefined), 15_000);
  every(30 * 60_000, () => background());
  setTimeout(() => void background().catch(() => undefined), 60_000);
});
