import "server-only";
import fs from "node:fs";
import path from "node:path";
import YAML, { isMap, isScalar, isSeq, type Scalar } from "yaml";
import { docker } from "../docker/client";
import { host, CommandError } from "../host/exec";
import { hostPath, isWithin } from "../host/paths";
import type { LineChange } from "@/lib/storage-types";

/**
 * What Docker has bound where, and how to rewrite compose files when a mount point moves.
 * Rewrites are surgical: only the host side of volume definitions changes, the rest of the file
 * (comments, quoting, indentation, container-side paths) stays byte-for-byte identical.
 */

export interface ContainerBind {
  containerId: string;
  name: string;
  running: boolean;
  state: string;
  project: string | null;
  service: string | null;
  configFiles: string[];
  workingDir: string | null;
  type: string;
  source: string;
  destination: string;
  volumeName: string | null;
}

export interface ContainerRef {
  id: string;
  name: string;
  running: boolean;
  state: string;
  project: string | null;
  service: string | null;
  configFiles: string[];
  workingDir: string | null;
  binds: ContainerBind[];
}

export async function listContainerRefs(): Promise<ContainerRef[]> {
  const list = await docker().listContainers({ all: true });
  return list.map((c) => {
    const labels = c.Labels ?? {};
    const project = labels["com.docker.compose.project"] ?? null;
    const configFiles = (labels["com.docker.compose.project.config_files"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const base = {
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
      running: c.State === "running" || c.State === "restarting" || c.State === "paused",
      state: c.State,
      project,
      service: labels["com.docker.compose.service"] ?? null,
      configFiles,
      workingDir: labels["com.docker.compose.project.working_dir"] ?? null,
    };
    const binds: ContainerBind[] = (c.Mounts ?? []).map((m) => ({
      containerId: base.id,
      name: base.name,
      running: base.running,
      state: base.state,
      project,
      service: base.service,
      configFiles,
      workingDir: base.workingDir,
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      volumeName: (m as { Name?: string }).Name ?? null,
    }));
    return { ...base, binds };
  });
}

/** Named volumes whose data really lives somewhere else (local driver with o=bind, device=/path). */
export async function boundVolumes(): Promise<{ name: string; device: string }[]> {
  try {
    const { Volumes } = await docker().listVolumes();
    return (Volumes ?? [])
      .map((v) => ({ name: v.Name, device: (v.Options as Record<string, string> | null)?.device ?? "" }))
      .filter((v) => v.device.startsWith("/"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- compose commands

export interface ComposeProject {
  project: string;
  files: string[];
  workingDir: string | null;
}

function composeBase(p: ComposeProject, envFile?: string): string[] {
  const args = ["compose", "-p", p.project];
  for (const f of p.files) args.push("-f", f);
  if (p.workingDir) args.push("--project-directory", p.workingDir);
  if (envFile) args.push("--env-file", envFile);
  return args;
}

export async function compose(p: ComposeProject, args: string[], timeoutMs = 5 * 60_000) {
  return host("docker", [...composeBase(p), ...args], { timeoutMs });
}

export interface ResolvedVolume {
  service: string;
  type: string;
  source: string;
  target: string;
}

/** `docker compose config` → the host paths each service would bind. */
export async function resolvedVolumes(p: ComposeProject, opts: { files?: string[]; envFile?: string } = {}): Promise<ResolvedVolume[]> {
  const proj = { ...p, files: opts.files ?? p.files };
  let stdout: string;
  try {
    stdout = (await host("docker", [...composeBase(proj, opts.envFile), "config", "--format", "json"], { timeoutMs: 60_000 })).stdout;
  } catch (e) {
    const msg = e instanceof CommandError ? e.stderr.trim().split("\n").slice(-2).join(" ") || e.message : (e as Error).message;
    throw new Error(msg);
  }
  const cfg = JSON.parse(stdout) as { services?: Record<string, { volumes?: { type?: string; source?: string; target?: string }[] }>; volumes?: Record<string, { driver_opts?: Record<string, string> }> };
  const out: ResolvedVolume[] = [];
  for (const [service, s] of Object.entries(cfg.services ?? {})) {
    for (const v of s.volumes ?? []) {
      if (v.source) out.push({ service, type: v.type ?? "bind", source: v.source, target: v.target ?? "" });
    }
  }
  for (const [name, v] of Object.entries(cfg.volumes ?? {})) {
    const dev = v.driver_opts?.device;
    if (dev) out.push({ service: `(volume ${name})`, type: "volume-device", source: dev, target: "" });
  }
  return out;
}

// ---------------------------------------------------------------- rewriting

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches `oldPath` only as a whole path prefix (so /mnt/hdd2 doesn't match /mnt/hdd20). */
export function prefixRegex(oldPath: string): RegExp {
  return new RegExp(`(^|[\\s"'=:,(\\[{-])${esc(oldPath)}(?=$|[/\\s"':,)\\]}])`, "g");
}

export function replacePrefix(s: string, oldPath: string, newPath: string): string {
  return s.replace(prefixRegex(oldPath), (_m, pre: string) => `${pre}${newPath}`);
}

export function mentionsPath(s: string, oldPath: string): boolean {
  return prefixRegex(oldPath).test(s);
}

/** Split a short-syntax volume "SRC:DST[:MODE]" at the first colon that isn't inside ${…}. */
function shortSourceEnd(v: string): number {
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "$" && v[i + 1] === "{") {
      depth++;
      i++;
    } else if (c === "}" && depth > 0) depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface FileScan {
  edits: Edit[];
  /** Variables used in volume sources (so a .env value for them is a host path). */
  sourceVars: Set<string>;
  /** Mentions of the old path we didn't touch (container paths, labels, commands…). */
  untouched: { line: number; text: string }[];
  /** Volume sources that mention the old path but couldn't be edited safely (escapes, aliases). */
  problems: string[];
  parseError: string | null;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Plan an edit to a scalar node: replace `oldPath` with `newPath` inside [from, to) of the value,
 * provided the source text is a literal copy of the value (no escapes) so offsets line up.
 */
function scalarEdit(text: string, node: Scalar, from: number, to: number, oldPath: string, newPath: string, problems: string[]): Edit | null {
  if (!node.range || typeof node.value !== "string") return null;
  const value = node.value;
  const part = value.slice(from, to);
  const replaced = replacePrefix(part, oldPath, newPath);
  if (replaced === part) return null;
  const [start, end] = node.range;
  const raw = text.slice(start, end);
  const quoted = node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE";
  const inner = quoted ? raw.slice(1, -1) : raw;
  if (inner !== value || (node.type !== "PLAIN" && !quoted)) {
    problems.push(`line ${lineOf(text, start)}: ${value}`);
    return null;
  }
  const off = start + (quoted ? 1 : 0);
  if (node.type === "QUOTE_DOUBLE" && /["\\]/.test(newPath)) return null;
  return { start: off + from, end: off + to, text: replaced };
}

export function scanComposeText(text: string, oldPath: string, newPath: string): FileScan {
  const res: FileScan = { edits: [], sourceVars: new Set(), untouched: [], problems: [], parseError: null };
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(text, { uniqueKeys: false });
  } catch (e) {
    res.parseError = (e as Error).message;
    return res;
  }
  if (doc.errors.length) {
    res.parseError = doc.errors[0]!.message;
    return res;
  }
  const noteVars = (s: string) => {
    for (const m of s.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) res.sourceVars.add(m[1]!);
  };

  const services = doc.get("services", true);
  if (isMap(services)) {
    for (const pair of services.items) {
      const svc = pair.value;
      if (!isMap(svc)) continue;
      const vols = svc.get("volumes", true);
      if (!isSeq(vols)) continue;
      for (const item of vols.items) {
        if (isScalar(item) && typeof item.value === "string") {
          const cut = shortSourceEnd(item.value);
          if (cut < 0) continue; // "- /data" is a container path (anonymous volume)
          noteVars(item.value.slice(0, cut));
          const e = scalarEdit(text, item, 0, cut, oldPath, newPath, res.problems);
          if (e) res.edits.push(e);
        } else if (isMap(item)) {
          const src = item.get("source", true);
          if (isScalar(src) && typeof src.value === "string") {
            noteVars(src.value);
            const e = scalarEdit(text, src, 0, src.value.length, oldPath, newPath, res.problems);
            if (e) res.edits.push(e);
          }
        } else if (item && mentionsPath(String((item as { source?: unknown }).source ?? ""), oldPath)) {
          res.problems.push(`an aliased volume entry in service ${String((pair.key as Scalar)?.value ?? "")}`);
        }
      }
    }
  }
  const volumes = doc.get("volumes", true);
  if (isMap(volumes)) {
    for (const pair of volumes.items) {
      const v = pair.value;
      if (!isMap(v)) continue;
      const opts = v.get("driver_opts", true);
      if (!isMap(opts)) continue;
      const dev = opts.get("device", true);
      if (isScalar(dev) && typeof dev.value === "string") {
        noteVars(dev.value);
        const e = scalarEdit(text, dev, 0, dev.value.length, oldPath, newPath, res.problems);
        if (e) res.edits.push(e);
      }
    }
  }

  // Everything else that mentions the old path: reported, not changed.
  const editedLines = new Set(res.edits.map((e) => lineOf(text, e.start)));
  text.split("\n").forEach((l, i) => {
    if (!editedLines.has(i + 1) && mentionsPath(l, oldPath)) res.untouched.push({ line: i + 1, text: l.trim().slice(0, 200) });
  });
  return res;
}

/** .env: rewrite KEY=VALUE only when KEY feeds a volume source and VALUE starts with the old path. */
export function scanEnvText(text: string, oldPath: string, newPath: string, sourceVars: Set<string>): FileScan {
  const res: FileScan = { edits: [], sourceVars, untouched: [], problems: [], parseError: null };
  let offset = 0;
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(["']?)(.*?)\4(\s*(?:#.*)?)$/);
    if (m && mentionsPath(m[5]!, oldPath)) {
      if (sourceVars.has(m[2]!) && (m[5] === oldPath || m[5]!.startsWith(`${oldPath}/`))) {
        const valStart = offset + m[1]!.length + m[2]!.length + m[3]!.length + m[4]!.length;
        res.edits.push({ start: valStart, end: valStart + oldPath.length, text: newPath });
      } else res.untouched.push({ line: i + 1, text: line.trim().slice(0, 200) });
    } else if (mentionsPath(line, oldPath)) res.untouched.push({ line: i + 1, text: line.trim().slice(0, 200) });
    offset += line.length + 1;
  });
  return res;
}

export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export function lineChanges(before: string, after: string): LineChange[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: LineChange[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push({ line: i + 1, before: a[i] ?? "", after: b[i] ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------- file access

/** Read a host file through its real path (so symlinks resolve on the host, not in the container). */
export function readHostText(realPath: string): string {
  return fs.readFileSync(hostPath(realPath), "utf8");
}

export function writeHostTextAtomic(realPath: string, text: string) {
  const live = hostPath(realPath);
  const st = fs.statSync(live);
  const tmp = path.posix.join(path.posix.dirname(live), `.${path.posix.basename(live)}.gluon-tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, "wx", st.mode & 0o7777);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chownSync(tmp, st.uid, st.gid);
    fs.renameSync(tmp, live);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function backupHostFile(realPath: string, ts: string): string {
  const backup = `${realPath}.gluon-bak-${ts}`;
  const st = fs.statSync(hostPath(realPath));
  fs.copyFileSync(hostPath(realPath), hostPath(backup), fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(hostPath(backup), st.mode & 0o7777);
    fs.chownSync(hostPath(backup), st.uid, st.gid);
  } catch {
    /* best effort */
  }
  return backup;
}

export function restoreHostFile(realPath: string, backup: string) {
  const text = fs.readFileSync(hostPath(backup), "utf8");
  writeHostTextAtomic(realPath, text);
}

/** Map a path under `from` to the same place under `to`. */
export function movePath(p: string, from: string, to: string): string {
  // Non-paths ("none" for swap, "UUID=…") are left alone.
  if (!p.startsWith("/") || p.includes("\0")) return p;
  return isWithin(p, from) ? to + p.slice(from.length) : p;
}
