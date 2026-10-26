import "server-only";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../errors";
import { hostPath, normalizeHostPath } from "../host/paths";

/**
 * Changes made through folders that can't be swapped underneath us.
 *
 * Every Files request resolves and checks a path first, but the kernel walks the path again when
 * the change happens. Anyone who can write in a shared folder some other way (Samba, an app's
 * container, a shell) could swap a folder on the way for a symlink to `/` in between, and Gluon,
 * running as root, would then write wherever that points. So changes are made relative to a folder
 * opened one component at a time with O_NOFOLLOW: once it's open, the folder itself is used (through
 * /proc/self/fd/N), however its path changes afterwards.
 *
 * Where /proc/self/fd isn't available (a Mac running the dev server) the same walk only checks
 * each component with lstat, which narrows the window but can't close it.
 */

const PROC_FD = process.platform === "linux" && fs.existsSync("/proc/self/fd");
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;

export class Changed extends AppError {
  constructor(what = "A folder on the way") {
    super("changed", `${what} changed while Gluon was working on it, so it stopped without changing anything there. Try again.`, 409);
  }
}

export interface Dir {
  /** The folder's resolved host path, as it was checked. */
  real: string;
  stat: fs.Stats;
  /** A path to the open folder itself (to list it). */
  here: string;
  /** The open descriptor, to hand to a child process (null where folders aren't held open). */
  fd: number | null;
  /** A path to a direct child that the kernel reaches through this open folder, never through links on the way. */
  at(name: string): string;
  chmod(mode: number): Promise<void>;
  chown(uid: number, gid: number): Promise<void>;
  utimes(atime: Date, mtime: Date): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** A single name inside a folder: no separators, nothing that walks up. */
export function childName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new AppError("bad_name", "That name can't be used here.", 400);
  return name;
}

function isLoop(e: unknown) {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK";
}

/**
 * Open the folder at the resolved host path `real`, refusing if any part of the path is now a
 * symlink, and (with `expect`) if it isn't the same folder the check saw.
 */
export async function openDir(real: string, expect?: Pick<fs.Stats, "dev" | "ino"> | null): Promise<Dir> {
  const norm = normalizeHostPath(real);
  const parts = norm.split("/").filter(Boolean);
  if (!PROC_FD) return openDirChecked(norm, parts, expect);

  let fh = await fs.promises.open(hostPath("/"), O_RDONLY | O_DIRECTORY);
  try {
    for (const part of parts) {
      let next: fs.promises.FileHandle;
      try {
        next = await fs.promises.open(`/proc/self/fd/${fh.fd}/${part}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      } catch (e) {
        if (isLoop(e)) throw new Changed();
        throw e;
      }
      await fh.close();
      fh = next;
    }
    const stat = await fh.stat();
    if (expect && (stat.dev !== expect.dev || stat.ino !== expect.ino)) throw new Changed("The folder");
    const handle = fh;
    return {
      real: norm,
      stat,
      here: `/proc/self/fd/${handle.fd}`,
      fd: handle.fd,
      at: (name) => `/proc/self/fd/${handle.fd}/${childName(name)}`,
      chmod: (mode) => handle.chmod(mode),
      chown: (uid, gid) => handle.chown(uid, gid),
      utimes: (a, m) => handle.utimes(a, m),
      sync: () => handle.sync().catch(() => {}),
      close: () => handle.close().catch(() => {}),
    };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

async function openDirChecked(norm: string, parts: string[], expect?: Pick<fs.Stats, "dev" | "ino"> | null): Promise<Dir> {
  let cur = "/";
  let stat = await fs.promises.lstat(hostPath("/"));
  for (const part of parts) {
    cur = path.posix.join(cur, part);
    stat = await fs.promises.lstat(hostPath(cur));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Changed();
  }
  if (expect && (stat.dev !== expect.dev || stat.ino !== expect.ino)) throw new Changed("The folder");
  const p = hostPath(norm);
  return {
    real: norm,
    stat,
    here: p,
    fd: null,
    at: (name) => path.posix.join(p, childName(name)),
    chmod: (mode) => fs.promises.chmod(p, mode),
    chown: (uid, gid) => fs.promises.lchown(p, uid, gid),
    utimes: (a, m) => fs.promises.utimes(p, a, m),
    sync: async () => {
      const h = await fs.promises.open(p, "r").catch(() => null);
      await h?.sync().catch(() => {});
      await h?.close();
    },
    close: async () => {},
  };
}

/** Run `fn` with the folder open, closing it afterwards. */
export async function inDir<T>(real: string, expect: Pick<fs.Stats, "dev" | "ino"> | null | undefined, fn: (dir: Dir) => Promise<T>): Promise<T> {
  const dir = await openDir(real, expect);
  try {
    return await fn(dir);
  } finally {
    await dir.close();
  }
}

/** Run `fn` with the folder that holds `real` open, and the item's name in it. */
export function inParent<T>(real: string, fn: (dir: Dir, name: string) => Promise<T>): Promise<T> {
  const norm = normalizeHostPath(real);
  return inDir(path.posix.dirname(norm), null, (dir) => fn(dir, path.posix.basename(norm)));
}

/**
 * Make `real` and any missing folders above it, each one inside the last (never through a link).
 * Returns the folders it created, outermost first.
 */
export async function mkdirs(real: string, mode = 0o755): Promise<string[]> {
  const norm = normalizeHostPath(real);
  const parts = norm.split("/").filter(Boolean);
  // The deepest folder that already exists.
  let have = 0;
  for (let i = parts.length; i > 0; i--) {
    try {
      const st = await fs.promises.lstat(hostPath(`/${parts.slice(0, i).join("/")}`));
      if (!st.isDirectory()) throw new Changed();
      have = i;
      break;
    } catch (e) {
      if (e instanceof Changed) throw e;
    }
  }
  const made: string[] = [];
  for (let i = have; i < parts.length; i++) {
    const parent = `/${parts.slice(0, i).join("/")}`;
    await inDir(parent, null, async (dir) => {
      try {
        await fs.promises.mkdir(dir.at(parts[i]!), { mode });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    });
    made.push(path.posix.join(parent, parts[i]!));
  }
  return made;
}

/**
 * Open a file inside an open folder without following a link in its place, check it's the file
 * that was looked at (when `expect` is given), and hand back the handle.
 */
export async function openFileIn(dir: Dir, name: string, flags: number, mode?: number, expect?: Pick<fs.Stats, "dev" | "ino"> | null): Promise<fs.promises.FileHandle> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(dir.at(name), flags | O_NOFOLLOW, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Changed(name);
    throw e;
  }
  if (expect) {
    const st = await fh.stat();
    if (st.dev !== expect.dev || st.ino !== expect.ino) {
      await fh.close().catch(() => {});
      throw new Changed(name);
    }
  }
  return fh;
}
