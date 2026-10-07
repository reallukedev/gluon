import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError, conflict } from "../errors";
import { inDir, inParent, openFileIn } from "./safe";
import { isWithin } from "../host/paths";
import { audit } from "../audit";
import { docker } from "../docker/client";
import type { User } from "../auth/users";
import type { TextFile } from "@/lib/files-types";
import { formatBytes } from "@/lib/format";
import { assertMutable, authorize, cleanName, protectionReason } from "./paths";
import { languageOf } from "./kinds";

export const TEXT_LIMIT = 1024 * 1024;

type Encoding = TextFile["encoding"];

/** Decide how a byte buffer is encoded: BOMs, NULs (binary), valid UTF-8, else Latin-1. */
export function detect(buf: Buffer, truncated: boolean): { encoding: Encoding; text: string | null } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf-8", text: decodeUtf8(buf.subarray(3), truncated) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf-16le", text: new TextDecoder("utf-16le").decode(buf.subarray(2)) };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf-16be", text: new TextDecoder("utf-16be").decode(buf.subarray(2)) };
  const head = buf.subarray(0, 8192);
  let control = 0;
  for (const b of head) {
    if (b === 0) return { encoding: "binary", text: null };
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  if (head.length && control / head.length > 0.1) return { encoding: "binary", text: null };
  const utf8 = decodeUtf8(buf, truncated);
  if (utf8 !== null) return { encoding: "utf-8", text: utf8 };
  return { encoding: "latin1", text: buf.toString("latin1") };
}

function decodeUtf8(buf: Buffer, truncated: boolean): string | null {
  const dec = new TextDecoder("utf-8", { fatal: true });
  try {
    return dec.decode(buf);
  } catch {
    if (!truncated) return null;
    // The 1 MB cut may split a multi-byte character: retry without the last 1 to 3 bytes.
    for (let cut = 1; cut <= 3 && cut < buf.length; cut++) {
      try {
        return dec.decode(buf.subarray(0, buf.length - cut));
      } catch {
        /* keep trying */
      }
    }
    return null;
  }
}

export async function readText(user: User, p: string): Promise<TextFile> {
  const t = await authorize(user, p, "read");
  if (!t.stat?.isFile()) throw new AppError("not_a_file", "Only files can be previewed as text.", 400);
  if (["/proc", "/sys", "/dev"].some((x) => isWithin(t.real, x))) throw new AppError("not_streamable", "Files in /proc, /sys and /dev can't be previewed.", 400);
  const fh = await fs.promises.open(t.fsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    // A folder on the way swapped for a link would open a different file: refuse rather than show it.
    if (st.ino !== t.stat.ino || st.dev !== t.stat.dev) throw new AppError("changed", "That file changed while opening it. Try again.", 409);
    const want = Math.min(st.size, TEXT_LIMIT);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const truncated = st.size > TEXT_LIMIT;
    const { encoding, text } = detect(buf.subarray(0, got), truncated);
    let readOnlyReason: string | null = null;
    if (t.access !== "write") readOnlyReason = "You can view this file but not change it.";
    else if (truncated) readOnlyReason = `It's larger than ${formatBytes(TEXT_LIMIT)}, so only the start is shown and it can't be edited here.`;
    else if (encoding === "binary") readOnlyReason = "It isn't a text file.";
    else if (encoding !== "utf-8") readOnlyReason = "It isn't UTF-8 text, so editing it here could damage it.";
    else readOnlyReason = await protectionReason(t.real, "edit");
    return {
      path: t.path,
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      encoding,
      truncated,
      content: text,
      editable: !readOnlyReason,
      readOnlyReason,
      language: languageOf(path.posix.basename(t.path)),
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Is `real` bind-mounted as a single file into a container? Replacing its inode would detach it. */
async function isBindMountedFile(real: string): Promise<boolean> {
  try {
    const list = await docker().listContainers({ all: true });
    return list.some((c) => (c.Mounts ?? []).some((m) => m.Type === "bind" && m.Source === real));
  } catch {
    return true; // unknown: be conservative and write in place
  }
}

/**
 * Save a small text file. `expectedMtime` must match the file on disk (someone may have edited it
 * by hand since it was opened); pass null with `create` to make a new file.
 */
export async function saveText(
  user: User,
  input: { path: string; content: string; expectedMtime: number | null; create?: boolean },
  where: { ip: string; zone: string },
): Promise<{ path: string; size: number; mtime: number }> {
  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.length > TEXT_LIMIT) throw new AppError("too_large", `Files edited here can be up to ${formatBytes(TEXT_LIMIT)}.`, 413);

  if (input.create) {
    const parentPath = path.posix.dirname(input.path);
    const name = cleanName(path.posix.basename(input.path), "file name");
    const dir = await authorize(user, parentPath, "write");
    if (!dir.stat?.isDirectory()) throw new AppError("not_a_folder", "Choose a folder to create the file in.", 400);
    await assertMutable(dir.real, "create files in");
    const real = path.posix.join(dir.real, name);
    const owner = dir.stat;
    const st = await inDir(dir.real, dir.stat, async (d) => {
      let fd: fs.promises.FileHandle;
      try {
        fd = await openFileIn(d, name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw conflict(`There's already something called ${name} here.`);
        throw e;
      }
      try {
        await fd.writeFile(bytes);
        await fd.sync();
        await fd.chown(owner.uid, owner.gid).catch(() => {});
        return await fd.stat();
      } finally {
        await fd.close();
      }
    });
    audit(user, { action: "files.create", summary: `Created ${name}`, target: real, detail: { size: bytes.length } }, where);
    return { path: path.posix.join(dir.path, name), size: st.size, mtime: Math.round(st.mtimeMs) };
  }

  const t = await authorize(user, input.path, "write");
  if (!t.stat?.isFile()) throw new AppError("not_a_file", "Only files can be edited.", 400);
  await assertMutable(t.real, "edit");
  const name = path.posix.basename(t.real);
  const current = await fs.promises.lstat(t.fsPath);
  if (input.expectedMtime !== null && Math.round(current.mtimeMs) !== Math.round(input.expectedMtime)) {
    throw new AppError("changed", `${name} was changed by something else since you opened it. Reload it to see the new version, then make your edits again.`, 409, {
      mtime: Math.round(current.mtimeMs),
      size: current.size,
    });
  }
  if (current.size > TEXT_LIMIT) throw new AppError("too_large", "That file is too large to edit here.", 413);

  // Atomic replace (temp + rename) unless the file's identity matters: hard links, or a container
  // bind-mounts this exact file (it would keep seeing the old inode). Both happen inside the
  // file's folder opened without following links, on the file that was checked.
  const inPlace = current.nlink > 1 || (await isBindMountedFile(t.real));
  const st = await inParent(t.real, async (d, base) => {
    if (inPlace) {
      const fh = await openFileIn(d, base, fs.constants.O_WRONLY, undefined, current);
      try {
        await fh.truncate(0);
        await fh.write(bytes, 0, bytes.length, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } else {
      const tmpName = `.${name}.gluon-${crypto.randomBytes(4).toString("hex")}.tmp`;
      const fh = await openFileIn(d, tmpName, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, current.mode & 0o7777);
      try {
        await fh.writeFile(bytes);
        await fh.chmod(current.mode & 0o7777);
        await fh.chown(current.uid, current.gid).catch(() => {});
        await fh.sync();
      } catch (e) {
        await fh.close().catch(() => {});
        await fs.promises.unlink(d.at(tmpName)).catch(() => {});
        throw e;
      }
      await fh.close();
      // Last check right before replacing.
      const again = await fs.promises.lstat(d.at(base));
      if (again.mtimeMs !== current.mtimeMs || again.ino !== current.ino) {
        await fs.promises.unlink(d.at(tmpName)).catch(() => {});
        throw new AppError("changed", `${name} was changed by something else while saving. Reload it and try again.`, 409, { mtime: Math.round(again.mtimeMs), size: again.size });
      }
      await fs.promises.rename(d.at(tmpName), d.at(base));
    }
    return fs.promises.lstat(d.at(base));
  });
  audit(user, { action: "files.edit", summary: `Edited ${name}`, target: t.real, detail: { before: current.size, after: st.size, inPlace } }, where);
  return { path: t.path, size: st.size, mtime: Math.round(st.mtimeMs) };
}
