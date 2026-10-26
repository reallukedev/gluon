import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { host, CommandError } from "../host/exec";
import { hostPath } from "../host/paths";
import { AppError, conflict } from "../errors";
import { unescapeOctal } from "./mounts";
import type { FstabBackup, FstabSourceKind } from "@/lib/storage-types";

/**
 * /etc/fstab: a parser/serializer that keeps every comment, blank and unknown line exactly as it was,
 * plus the one safe way to write it (backup → temp file → findmnt --verify → atomic rename).
 */

export const FSTAB = "/etc/fstab";
const BACKUP_PREFIX = "fstab.gluon-";
const KEEP_BACKUPS = 10;

export interface FstabEntry {
  spec: string;
  file: string;
  vfstype: string;
  mntops: string[];
  freq: number;
  passno: number;
}

export interface FstabLine {
  /** 0-based index into the file's lines. */
  index: number;
  raw: string;
  kind: "blank" | "comment" | "entry" | "invalid";
  entry: FstabEntry | null;
}

export interface ParsedFstab {
  lines: FstabLine[];
  trailingNewline: boolean;
}

function escapeField(s: string): string {
  return s.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
}

export function parseFstab(text: string): ParsedFstab {
  const trailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (trailingNewline) rawLines.pop();
  const lines: FstabLine[] = rawLines.map((raw, index) => {
    const t = raw.trim();
    if (!t) return { index, raw, kind: "blank", entry: null };
    if (t.startsWith("#")) return { index, raw, kind: "comment", entry: null };
    const f = t.split(/\s+/);
    if (f.length < 3) return { index, raw, kind: "invalid", entry: null };
    const freq = Number(f[4] ?? 0);
    const passno = Number(f[5] ?? 0);
    return {
      index,
      raw,
      kind: "entry",
      entry: {
        spec: unescapeOctal(f[0]!),
        file: unescapeOctal(f[1]!),
        vfstype: f[2]!,
        mntops: (f[3] ?? "defaults").split(",").filter(Boolean),
        freq: Number.isFinite(freq) ? freq : 0,
        passno: Number.isFinite(passno) ? passno : 0,
      },
    };
  });
  return { lines, trailingNewline };
}

export function formatEntry(e: FstabEntry): string {
  return [escapeField(e.spec), escapeField(e.file), e.vfstype, e.mntops.join(",") || "defaults", String(e.freq), String(e.passno)].join(" ");
}

export function serializeFstab(p: ParsedFstab): string {
  const body = p.lines.map((l) => l.raw).join("\n");
  return p.lines.length ? body + (p.trailingNewline ? "\n" : "") : "";
}

export function readFstabText(): string {
  try {
    return fs.readFileSync(hostPath(FSTAB), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new AppError("fstab_unreadable", `Gluon couldn't read /etc/fstab: ${(e as Error).message}`, 500);
  }
}

export function readFstab(): { text: string; parsed: ParsedFstab } {
  const text = readFstabText();
  return { text, parsed: parseFstab(text) };
}

// ---------------------------------------------------------------- sources

export interface SourceRef {
  kind: FstabSourceKind;
  value: string;
}

const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "sshfs", "fuse.sshfs", "glusterfs", "ceph", "9p", "davfs"]);

export function sourceRef(e: FstabEntry): SourceRef {
  const s = e.spec;
  if (e.mntops.includes("bind") || e.mntops.includes("rbind")) return { kind: "path", value: s };
  if (NETWORK_FS.has(e.vfstype) || /^[^/]+:\//.test(s) || s.startsWith("//")) return { kind: "network", value: s };
  const eq = s.match(/^(UUID|LABEL|PARTUUID|PARTLABEL)=(.*)$/i);
  if (eq) {
    const v = eq[2]!.replace(/^"(.*)"$/, "$1");
    const k = eq[1]!.toUpperCase();
    return { kind: k === "UUID" ? "uuid" : k === "LABEL" ? "label" : k === "PARTUUID" ? "partuuid" : "partlabel", value: v };
  }
  const by = s.match(/^\/dev\/disk\/by-(uuid|label|partuuid|partlabel)\/(.+)$/);
  if (by) {
    const k = by[1]!;
    return { kind: k as FstabSourceKind, value: unescapeUdev(by[2]!) };
  }
  if (s.startsWith("/dev/disk/")) return { kind: "link", value: s };
  if (s.startsWith("/dev/")) return { kind: "device", value: s };
  if (s === "none" || s === "tmpfs" || s === "proc" || s === "sysfs") return { kind: "none", value: s };
  if (s.startsWith("/")) return { kind: "path", value: s };
  return { kind: "none", value: s };
}

/** udev escapes spaces in by-label names as \x20. */
function unescapeUdev(s: string): string {
  return s.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Resolve a /dev/disk/by-* link on the host to its /dev node, without following into the container. */
export function resolveDevLink(p: string): string | null {
  try {
    const link = fs.readlinkSync(hostPath(p));
    return path.posix.resolve(path.posix.dirname(p), link);
  } catch {
    return null;
  }
}

export interface VolumeIdentity {
  path: string;
  /** Other names for the same node: /dev/mapper/x, /dev/dm-0. */
  aliases?: string[];
  uuid: string | null;
  label: string | null;
  partUuid: string | null;
  partLabel: string | null;
}

/** Does this fstab entry's source refer to the volume? Returns how it matched. */
export function matchesVolume(e: FstabEntry, v: VolumeIdentity): FstabSourceKind | null {
  const ref = sourceRef(e);
  const eqi = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  switch (ref.kind) {
    case "uuid":
      return eqi(v.uuid, ref.value) ? "uuid" : null;
    case "label":
      return v.label && v.label === ref.value ? "label" : null;
    case "partuuid":
      return eqi(v.partUuid, ref.value) ? "partuuid" : null;
    case "partlabel":
      return v.partLabel && v.partLabel === ref.value ? "partlabel" : null;
    case "device":
      return ref.value === v.path || v.aliases?.includes(ref.value) ? "device" : null;
    case "link": {
      const r = resolveDevLink(ref.value);
      return r && (r === v.path || v.aliases?.includes(r)) ? "link" : null;
    }
    default:
      return null;
  }
}

export const isSwapEntry = (e: FstabEntry) => e.vfstype === "swap";
export const isBindEntry = (e: FstabEntry) => e.mntops.includes("bind") || e.mntops.includes("rbind");

// ---------------------------------------------------------------- changes

export type FstabChange =
  | { kind: "add"; entry: FstabEntry; comment?: string }
  | { kind: "replace"; index: number; expectRaw: string; entry: FstabEntry }
  | { kind: "remove"; index: number; expectRaw: string }
  | { kind: "comment-out"; index: number; expectRaw: string; note: string };

/** Apply changes to the current text. Refuses if a line changed since the plan was made. */
export function applyChanges(text: string, changes: FstabChange[]): string {
  const p = parseFstab(text);
  const byIndex = new Map(p.lines.map((l) => [l.index, l]));
  const drop = new Set<number>();
  for (const c of changes) {
    if (c.kind === "add") continue;
    const l = byIndex.get(c.index);
    if (!l || l.raw !== c.expectRaw) throw conflict("/etc/fstab was changed by someone else just now. Review the change again.");
    if (c.kind === "replace") l.raw = formatEntry(c.entry);
    else if (c.kind === "comment-out") l.raw = `# ${c.note}: ${l.raw}`;
    else drop.add(c.index);
  }
  let lines = p.lines.filter((l) => !drop.has(l.index)).map((l) => l.raw);
  // Remove a "# Added by Gluon" comment left directly above a removed line.
  if (drop.size) {
    const kept: string[] = [];
    const original = p.lines;
    for (let i = 0; i < original.length; i++) {
      const l = original[i]!;
      if (drop.has(l.index)) continue;
      const next = original[i + 1];
      if (next && drop.has(next.index) && /^#\s*Added by (?:Gluon|Tend)\b/.test(l.raw.trim())) continue;
      kept.push(l.raw);
    }
    lines = kept;
  }
  for (const c of changes) {
    if (c.kind !== "add") continue;
    if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
    if (c.comment) lines.push(`# ${c.comment.replace(/\n/g, " ")}`);
    lines.push(formatEntry(c.entry));
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function gluonComment(what: string): string {
  return `Added by Gluon on ${new Date().toISOString().slice(0, 10)}: ${what}`;
}

// ---------------------------------------------------------------- verify

export interface VerifyResult {
  ok: boolean;
  errors: { target: string; message: string }[];
  warnings: { target: string; message: string }[];
  parseErrors: number;
  crashed: boolean;
  output: string;
}

export async function verifyFstabFile(file: string): Promise<VerifyResult> {
  let stdout = "";
  let stderr = "";
  let crashed = false;
  let code: number | null = 0;
  try {
    const r = await host("findmnt", ["--verify", "--tab-file", file], { timeoutMs: 30_000 });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    if (e instanceof CommandError) {
      stdout = e.stdout;
      stderr = e.stderr;
      code = e.code;
      if (code === null || code > 1) crashed = true;
    } else throw e;
  }
  const errors: VerifyResult["errors"] = [];
  const warnings: VerifyResult["warnings"] = [];
  let target = "";
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^\s+\[([EW ])\]\s+(.*)$/);
    if (m) {
      if (m[1] === "E") errors.push({ target, message: m[2]! });
      else if (m[1] === "W") warnings.push({ target, message: m[2]! });
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("findmnt:") && !/parse errors?,/.test(line)) target = line.trim();
  }
  const parseErrors = (stderr.match(/parse error/g) ?? []).length;
  return { ok: !crashed && errors.length === 0 && parseErrors === 0, errors, warnings, parseErrors, crashed, output: `${stdout}${stderr}`.slice(0, 4000) };
}

// ---------------------------------------------------------------- write

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function listBackups(): FstabBackup[] {
  try {
    return fs
      .readdirSync(hostPath("/etc"))
      .filter((n) => n.startsWith(BACKUP_PREFIX) && /^fstab\.gluon-\d{8}-\d{6}(-\d+)?$/.test(n))
      .map((n) => {
        const st = fs.statSync(hostPath(`/etc/${n}`));
        return { path: `/etc/${n}`, at: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.path.localeCompare(a.path));
  } catch {
    return [];
  }
}

function pruneBackups() {
  const all = listBackups();
  for (const b of all.slice(KEEP_BACKUPS)) {
    try {
      fs.unlinkSync(hostPath(b.path));
    } catch {
      /* best effort */
    }
  }
}

function fsyncPath(p: string, dir = false) {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, dir ? "r" : "r+");
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeFileDurable(file: string, text: string, mode: number) {
  const fd = fs.openSync(file, "wx", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function verifyKey(e: { target: string; message: string }) {
  return `${e.target}|${e.message}`;
}

export interface FstabWrite {
  backup: string;
  before: string;
  after: string;
}

/**
 * Replace /etc/fstab with `next`.
 * 1. Refuse if the file changed since `expectCurrent` was read (someone edited it by hand).
 * 2. Copy the current file to /etc/fstab.gluon-YYYYMMDD-HHMMSS (UTC); keep the newest 10.
 * 3. Write the new text to a temp file next to it and check it with `findmnt --verify`.
 *    Problems that already existed in the current file are tolerated; new ones abort.
 * 4. Atomically rename the temp file over /etc/fstab, then re-read it to confirm. If that fails, restore the backup.
 */
export async function writeFstab(next: string, expectCurrent: string): Promise<FstabWrite> {
  const live = hostPath(FSTAB);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(live);
  } catch (e) {
    throw new AppError("fstab_unreadable", `Gluon couldn't read /etc/fstab: ${(e as Error).message}`, 500);
  }
  if (st.isSymbolicLink()) throw new AppError("fstab_link", "/etc/fstab is a link to another file, so Gluon won't edit it. Change it by hand.", 409);
  const current = fs.readFileSync(live, "utf8");
  if (current !== expectCurrent) throw conflict("/etc/fstab was changed by someone else just now. Review the change again.");
  if (current === next) return { backup: "", before: current, after: next };

  // Backup.
  let backupName = `${BACKUP_PREFIX}${stamp()}`;
  for (let i = 2; fs.existsSync(hostPath(`/etc/${backupName}`)); i++) backupName = `${BACKUP_PREFIX}${stamp()}-${i}`;
  const backup = `/etc/${backupName}`;
  try {
    writeFileDurable(hostPath(backup), current, st.mode & 0o7777);
    fs.chownSync(hostPath(backup), st.uid, st.gid);
  } catch (e) {
    throw new AppError("fstab_backup", `Gluon couldn't back up /etc/fstab, so it didn't change it: ${(e as Error).message}`, 500);
  }

  // Temp file + verification.
  const tmp = `/etc/.fstab.gluon-new-${crypto.randomBytes(4).toString("hex")}`;
  try {
    writeFileDurable(hostPath(tmp), next, st.mode & 0o7777);
    fs.chownSync(hostPath(tmp), st.uid, st.gid);
    const [now, then] = await Promise.all([verifyFstabFile(FSTAB), verifyFstabFile(tmp)]);
    if (then.crashed) throw new AppError("fstab_invalid", "Gluon couldn't check the new /etc/fstab (findmnt failed), so it left the file alone.", 500, { output: then.output });
    const known = new Set(now.errors.map(verifyKey));
    const fresh = then.errors.filter((e) => !known.has(verifyKey(e)));
    if (fresh.length || then.parseErrors > now.parseErrors) {
      throw new AppError(
        "fstab_invalid",
        `The new /etc/fstab didn't pass Linux's check, so Gluon left it unchanged: ${fresh.map((e) => `${e.target}: ${e.message}`).join("; ") || "the file couldn't be parsed"}.`,
        422,
        { errors: fresh, output: then.output },
      );
    }
    // Last look for a concurrent edit, then swap atomically.
    if (fs.readFileSync(live, "utf8") !== current) throw conflict("/etc/fstab was changed by someone else just now. Review the change again.");
    fs.renameSync(hostPath(tmp), live);
    fsyncPath(hostPath("/etc"), true);
  } catch (e) {
    try {
      fs.unlinkSync(hostPath(tmp));
    } catch {
      /* already renamed or never written */
    }
    // Nothing changed, so the backup of the unchanged file isn't needed.
    try {
      if (fs.readFileSync(live, "utf8") === current) fs.unlinkSync(hostPath(backup));
    } catch {
      /* keep it */
    }
    throw e;
  }

  // Confirm.
  const after = fs.readFileSync(live, "utf8");
  if (after !== next) {
    await restoreFstab(backup);
    throw new AppError("fstab_write", "/etc/fstab didn't end up as expected, so Gluon put the previous version back.", 500);
  }
  pruneBackups();
  await daemonReload();
  return { backup, before: current, after: next };
}

/** Put a backup back in place (atomically). */
export async function restoreFstab(backup: string): Promise<void> {
  if (!backup) return;
  if (!/^\/etc\/fstab\.gluon-\d{8}-\d{6}(-\d+)?$/.test(backup)) throw new AppError("invalid", "That isn't a Gluon fstab backup.");
  const text = fs.readFileSync(hostPath(backup), "utf8");
  const st = fs.statSync(hostPath(FSTAB));
  const tmp = `/etc/.fstab.gluon-restore-${crypto.randomBytes(4).toString("hex")}`;
  writeFileDurable(hostPath(tmp), text, st.mode & 0o7777);
  fs.chownSync(hostPath(tmp), st.uid, st.gid);
  fs.renameSync(hostPath(tmp), hostPath(FSTAB));
  fsyncPath(hostPath("/etc"), true);
  await daemonReload();
}

/** Let systemd regenerate its mount units from fstab. Failure is logged, not fatal. */
export async function daemonReload(): Promise<boolean> {
  try {
    await host("systemctl", ["daemon-reload"], { timeoutMs: 60_000 });
    return true;
  } catch (e) {
    console.error("[gluon] systemctl daemon-reload failed", (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------- systemd mount units

export interface MountUnit {
  file: string;
  what: string;
  where: string;
}

/** Hand-written .mount units under /etc/systemd/system also make mounts permanent. */
export function readMountUnits(): MountUnit[] {
  const dir = "/etc/systemd/system";
  let names: string[] = [];
  try {
    names = fs.readdirSync(hostPath(dir)).filter((n) => n.endsWith(".mount"));
  } catch {
    return [];
  }
  const out: MountUnit[] = [];
  for (const n of names) {
    try {
      const text = fs.readFileSync(hostPath(`${dir}/${n}`), "utf8");
      const what = text.match(/^\s*What\s*=\s*(.+)$/m)?.[1]?.trim();
      const where = text.match(/^\s*Where\s*=\s*(.+)$/m)?.[1]?.trim();
      if (what && where) out.push({ file: `${dir}/${n}`, what, where });
    } catch {
      /* unreadable or dangling link */
    }
  }
  return out;
}
