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
import type { GithubTarget, UpdateLog, UpdateMethod, UpdateOption, UpdateRun, UpdateStage, UpdatesStatus } from "@/lib/updates-types";
import { REPO, detectInstall, isNewer, latestOnGithub, runningBuild, umbrelStoreVersion, type InstallDetail } from "./source";

/**
 * Gluon updating itself. Two ways in:
 *  - GitHub: download a release (or the newest commit on main), build it on this server, and swap it
 *    in. The work runs as a transient systemd unit on the host (docker/gluon-update.sh), so it
 *    carries on while this container is replaced, checks the new one comes up healthy, and goes
 *    back to the previous image if it doesn't.
 *  - A store: ask Umbrel to update the app from its store, or have Compose pull the newer image a
 *    CasaOS install names. Gluon never publishes to a store; it only takes what one offers.
 * Automatic updates run in a chosen hour, at most once a day.
 */

const DIR = "/var/lib/gluon";
const SCRIPT = `${DIR}/gluon-update.sh`;
const unitName = (id: string) => `gluon-update-${id}`;

type G = typeof globalThis & {
  __gluonUpdateCheck?: { at: number; channel: string; latest: GithubTarget | null; error: string | null };
  __gluonUpdateWatch?: ReturnType<typeof setInterval> | null;
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

// ---------------------------------------------------------------- checking

export async function check(force = false): Promise<{ latest: GithubTarget | null; error: string | null; at: number }> {
  const channel = getSetting("updates").channel;
  const c = g.__gluonUpdateCheck;
  // Background checks every 6 hours; a person pressing "Check now" gets a fresh answer (GitHub allows 60/hour).
  if (!force && c && c.channel === channel && Date.now() - c.at < 6 * 3600_000) return { latest: c.latest, error: c.error, at: c.at };
  let latest: GithubTarget | null = null;
  let error: string | null = null;
  try {
    latest = await latestOnGithub(channel);
    if (!latest) error = channel === "releases" ? "No releases have been published on GitHub yet." : "GitHub has no commits on main.";
  } catch (e) {
    error = (e as Error).message;
  }
  g.__gluonUpdateCheck = { at: Date.now(), channel, latest, error };
  return { latest, error, at: g.__gluonUpdateCheck.at };
}

async function options(detail: InstallDetail, latest: GithubTarget | null, newer: boolean): Promise<UpdateOption[]> {
  const out: UpdateOption[] = [];
  const kind = detail.install.kind;
  const canSwap = kind === "umbrel" || kind === "compose" || kind === "casaos";
  const why =
    kind === "development"
      ? "This is a development copy; update it with git."
      : kind === "docker"
        ? "Gluon was started with docker run, so it can't recreate its own container. Run it with Docker Compose to update from here."
        : kind === "unknown"
          ? "Gluon can't find its own container, so it can't replace itself."
          : !latest
            ? "Nothing to download yet."
            : !newer
              ? "You're on the newest version."
              : null;
  out.push({
    method: "github",
    label: latest ? `Download ${latest.version} from GitHub and build it on this server (a few minutes).` : "Download from GitHub and build it on this server.",
    available: canSwap && !!latest && newer,
    reason: why,
    target: latest,
    storeVersion: null,
  });
  if (detail.install.kind === "umbrel") {
    const offered = await umbrelStoreVersion(detail.install.appId);
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

export async function status(force = false): Promise<UpdatesStatus> {
  await watch();
  const [detail, c] = await Promise.all([detectInstall(), check(force)]);
  const running = runningBuild();
  const settings = getSetting("updates");
  const newer = !!c.latest && isNewer(c.latest, running, settings.channel);
  const current = one<Row>("SELECT * FROM self_updates WHERE outcome = 'running' ORDER BY started_at DESC LIMIT 1");
  return {
    running,
    install: detail.install,
    repo: REPO,
    settings,
    checkedAt: c.at,
    checkError: c.error,
    latest: c.latest,
    updateAvailable: newer,
    options: await options(detail, c.latest, newer),
    current: current ? toRun(current) : null,
    recent: all<Row>("SELECT * FROM self_updates ORDER BY started_at DESC LIMIT 8").map(toRun),
  };
}

// ---------------------------------------------------------------- running an update

function readLog(file: string): string[] {
  try {
    return fs.readFileSync(hostPath(file), "utf8").split("\n").filter(Boolean).slice(-400);
  } catch {
    return [];
  }
}

/** Fold the updater's "::stage" / "::done" markers into the run's row. */
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

/** While a run is going, follow its log and tell open pages. */
async function watch() {
  const active = all<Row>("SELECT * FROM self_updates WHERE outcome = 'running'");
  for (const r of active) {
    const running = runningBuild();
    // Store updates and swaps that finished while this process was being replaced: judge by what's running now.
    if (r.method === "umbrel" && (running.build === r.to_version || running.version === r.to_version)) {
      run("UPDATE self_updates SET outcome = 'ok', message = ?, finished_at = ? WHERE id = ?", `Gluon ${r.to_version} is running.`, now(), r.id);
      continue;
    }
    const fresh = refresh(r);
    if (fresh.outcome === "running" && now() - fresh.started_at > 60 * 60_000) {
      run("UPDATE self_updates SET outcome = 'failed', message = ?, finished_at = ? WHERE id = ?", "The update didn't report back within an hour.", now(), r.id);
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

/** The updater script ships inside the image; the host runs its own copy of it. */
function installScript() {
  const candidates = [path.join(process.cwd(), "gluon-update.sh"), path.join(process.cwd(), "docker", "gluon-update.sh")];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) throw new AppError("updater_missing", "This copy of Gluon doesn't include its updater.", 500);
  fs.mkdirSync(hostPath(DIR), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, hostPath(SCRIPT));
  fs.chmodSync(hostPath(SCRIPT), 0o700);
}

export async function startUpdate(opts: { method: UpdateMethod; user: User | null; auto: boolean; where?: { ip: string; zone: string } }): Promise<UpdateRun> {
  await watch();
  if (one("SELECT id FROM self_updates WHERE outcome = 'running'")) throw new AppError("busy", "An update is already running.", 409);
  const s = await status(true);
  const opt = s.options.find((o) => o.method === opts.method);
  if (!opt?.available) throw new AppError("unavailable", opt?.reason ?? "That kind of update isn't possible here.", 409);
  const detail = await detectInstall();
  const id = Math.random().toString(36).slice(2, 10);
  const log = `${DIR}/update-${id}.log`;
  const from = s.running.version + (s.running.commit ? ` (${s.running.commit.slice(0, 7)})` : "");
  const to = opts.method === "github" ? opt.target!.version : (opt.storeVersion ?? "newest");

  run(
    "INSERT INTO self_updates (id, method, from_version, to_version, ref, started_at, outcome, stage, auto, user_id, username, log) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
    id,
    opts.method,
    from,
    to,
    opt.target?.ref ?? null,
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
        throw new Error("Gluon can't tell how it's installed.");
      };
      if (opts.method === "github") {
        const t = opt.target!;
        args = ["github", REPO, t.ref, t.version, t.commit, ...modeArgs()];
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
    const message = (e as Error).message || "Gluon couldn't start the update.";
    run("UPDATE self_updates SET outcome = 'failed', message = ?, finished_at = ? WHERE id = ?", message, now(), id);
    throw new AppError("start_failed", `The update couldn't start: ${message}`, 500);
  }

  const summary = `${opts.auto ? "Started an automatic update" : "Started updating Gluon"} to ${to} (${opts.method === "github" ? "from GitHub" : opts.method === "umbrel" ? "through Umbrel" : "by pulling the newest image"})`;
  if (opts.user) audit(opts.user, { action: "gluon.update", target: "gluon", summary, detail: { method: opts.method, from, to } }, opts.where);
  else systemEvent({ action: "gluon.update", target: "gluon", summary, detail: { method: opts.method, from, to } });
  await watch();
  return toRun(one<Row>("SELECT * FROM self_updates WHERE id = ?", id)!);
}

// ---------------------------------------------------------------- background: tell people, auto-update

async function background() {
  const s = await status();
  const settings = s.settings;
  const opt = s.options.find((o) => o.method === settings.method) ?? s.options[0];
  const available = s.options.filter((o) => o.available);
  if (!available.length || s.current) {
    resolve("gluon-update");
    return;
  }
  const name = s.latest && available.some((o) => o.method === "github") ? `Gluon ${s.latest.version}` : "A newer Gluon";
  if (settings.auto && opt?.available) {
    const hour = new Date().getHours();
    const lastAuto = one<{ t: number }>("SELECT MAX(started_at) AS t FROM self_updates WHERE auto = 1")?.t ?? 0;
    if (hour === settings.hour && now() - lastAuto > 20 * 3600_000) {
      await startUpdate({ method: opt.method, user: null, auto: true }).catch((e) =>
        systemEvent({ action: "gluon.update", target: "gluon", summary: `Automatic update didn't start: ${(e as Error).message}`, outcome: "failed" }),
      );
    }
    return;
  }
  raise({
    id: "gluon-update",
    kind: "gluon-update",
    severity: "info",
    subject: "gluon",
    title: `${name} is available`,
    cause: s.latest?.title && s.latest.title !== name ? s.latest.title : "Install it from Settings → Updates, or turn on automatic updates.",
    remedy: { action: "", label: "See the update", href: "/settings/updates" },
  });
}

onStart("updates", () => {
  // Finish the books on an update that replaced the previous process.
  setTimeout(() => void watch().catch(() => undefined), 15_000);
  every(30 * 60_000, background);
  setTimeout(() => void background().catch(() => undefined), 60_000);
});
