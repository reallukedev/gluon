import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { getApp, invalidateApps, type AppSummary } from "./apps";
import { host } from "../host/exec";
import { spawnLines } from "../apps/spawn";
import { hostPath } from "../host/paths";
import { AppError, conflict, notFound } from "../errors";

export interface ComposeFile {
  path: string;
  content: string;
  hash: string;
  casaos: boolean;
  backups: { name: string; at: number }[];
}

const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

async function appWithCompose(id: string): Promise<AppSummary & { configFile: string }> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  if (!app.configFile) throw new AppError("no_compose", "This app wasn't started with Docker Compose, so there's no file to edit.");
  return app as AppSummary & { configFile: string };
}

function backupsFor(file: string) {
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file);
  try {
    return fs
      .readdirSync(hostPath(dir))
      .filter((f) => f.startsWith(`${base}.gluon-`))
      .map((f) => ({ name: f, at: fs.statSync(hostPath(`${dir}/${f}`)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function readCompose(id: string): Promise<ComposeFile> {
  const app = await appWithCompose(id);
  const file = app.configFile.split(",")[0]!;
  const content = fs.readFileSync(hostPath(file), "utf8");
  return { path: file, content, hash: hashOf(content), casaos: app.source === "casaos", backups: backupsFor(file) };
}

export interface ValidationResult {
  ok: boolean;
  message: string;
  services?: string[];
}

/** Check YAML syntax locally, then ask Compose itself (with a temp file beside the real one so relative paths resolve). */
export async function validateCompose(id: string, content: string): Promise<ValidationResult> {
  const app = await appWithCompose(id);
  try {
    const doc = YAML.parse(content);
    if (!doc || typeof doc !== "object" || !doc.services) return { ok: false, message: "There's no services: section. A compose file needs at least one service." };
  } catch (e) {
    const err = e as { message: string; linePos?: { line: number }[] };
    return { ok: false, message: `YAML error${err.linePos?.[0] ? ` on line ${err.linePos[0].line}` : ""}: ${err.message.split("\n")[0]}` };
  }
  const file = app.configFile.split(",")[0]!;
  const dir = path.posix.dirname(file);
  const tmp = `${dir}/.gluon-validate-${process.pid}-${Date.now()}.yml`;
  fs.writeFileSync(hostPath(tmp), content, { mode: 0o600 });
  try {
    const { stdout } = await host("docker", ["compose", "-p", app.id, "--project-directory", app.workingDir ?? dir, "-f", tmp, "config", "--services"], { timeoutMs: 30_000 });
    return { ok: true, message: "Looks good.", services: stdout.trim().split("\n").filter(Boolean) };
  } catch (e) {
    const msg = (e as { stderr?: string; message: string }).stderr?.trim() || (e as Error).message;
    return { ok: false, message: msg.replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), path.posix.basename(file)).slice(0, 800) };
  } finally {
    fs.rmSync(hostPath(tmp), { force: true });
  }
}

/**
 * Save and apply a compose file. Streams progress lines. If `docker compose up` fails, the previous
 * file is restored and brought back up, so a bad edit can't leave the app down.
 */
export async function applyCompose(
  id: string,
  content: string,
  expectedHash: string,
  emit: (e: { type: "line"; text: string; stream: "out" | "err" } | { type: "step"; text: string } | { type: "done"; ok: boolean; message: string }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const app = await appWithCompose(id);
  if (app.self) throw new AppError("self", "Gluon can't edit its own compose file from here.");
  const file = app.configFile.split(",")[0]!;
  const current = fs.readFileSync(hostPath(file), "utf8");
  if (hashOf(current) !== expectedHash) throw conflict("The file changed on the server since you opened it. Reload to see the latest version.");
  const v = await validateCompose(id, content);
  if (!v.ok) throw new AppError("invalid_compose", v.message, 400);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = `${file}.gluon-${stamp}`;
  const st = fs.statSync(hostPath(file));
  emit({ type: "step", text: `Backed up the current file to ${path.posix.basename(backup)}` });
  fs.copyFileSync(hostPath(file), hostPath(backup));
  // Keep the last 10 backups.
  for (const old of backupsFor(file).slice(10)) fs.rmSync(hostPath(`${path.posix.dirname(file)}/${old.name}`), { force: true });

  const write = (text: string) => {
    const tmp = `${hostPath(file)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: st.mode & 0o777 });
    try {
      fs.chownSync(tmp, st.uid, st.gid);
    } catch {
      /* keep root */
    }
    fs.renameSync(tmp, hostPath(file));
  };
  write(content);
  emit({ type: "step", text: "Saved. Applying with docker compose up…" });

  const args = ["compose", "-p", app.id, ...app.configFile.split(",").flatMap((f) => ["-f", f]), "up", "-d", "--remove-orphans"];
  const line = (text: string, stream: "out" | "err") => emit({ type: "line", text, stream });
  // The edit stops if the page goes away or it runs too long. Putting the old file back never
  // stops early: leaving the app down would be worse than waiting.
  let first: { code: number; timedOut: boolean; aborted: boolean };
  try {
    first = await spawnLines("docker", args, line, { timeoutMs: 20 * 60_000, signal });
  } catch {
    first = { code: 1, timedOut: false, aborted: false };
  }
  invalidateApps();
  if (first.code === 0 && !first.aborted) {
    emit({ type: "done", ok: true, message: `${app.name} is running with the new configuration.` });
    return;
  }
  emit({ type: "step", text: first.aborted ? "The page closed before it finished. Putting the previous version back…" : first.timedOut ? "That took too long. Putting the previous version back…" : "That didn't start. Putting the previous version back…" });
  write(current);
  const back = (await spawnLines("docker", args, line, { timeoutMs: 20 * 60_000 }).catch(() => ({ code: 1 }))).code;
  invalidateApps();
  emit({
    type: "done",
    ok: false,
    message: back === 0 ? `The change didn't work, so ${app.name} is back on the previous version. The output above shows why.` : `The change didn't work and the previous version also failed to start. Check the output above. The version from before your edit is saved as ${path.posix.basename(backup)}.`,
  });
}

export async function readBackup(id: string, name: string): Promise<string> {
  const app = await appWithCompose(id);
  const file = app.configFile.split(",")[0]!;
  if (!/^[\w.-]+\.gluon-\d{8}T\d{6}$/.test(name) || !name.startsWith(path.posix.basename(file))) throw notFound("That backup");
  return fs.readFileSync(hostPath(`${path.posix.dirname(file)}/${name}`), "utf8");
}
