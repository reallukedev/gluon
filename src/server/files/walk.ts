import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { FileKind, SearchHit } from "@/lib/files-types";
import { kindOf } from "./kinds";

/**
 * Name search without `find`. The server runs GNU find (fast, and the default); this walker is only
 * used where find has no -printf, which in practice means a Mac running the dev server. It keeps the
 * same rules as the find command in search.ts: breadth first, no links followed, the trash and the
 * kernel's virtual folders skipped, and the same depth, count and time limits.
 */

export interface WalkOptions {
  /** Case-insensitive name test; null matches every name. */
  pattern: RegExp | null;
  /** The pattern may also match the path below the root (a folder on the way). */
  inPath?: boolean;
  type?: "file" | "dir" | "any";
  kinds: Set<FileKind> | null;
  /** Only things modified at or after this epoch ms (0 = any time). */
  since: number;
  minSize?: number;
  depth: number;
  limit: number;
  timeoutMs: number;
  /** Folder names never entered or listed (the trash). */
  skipNames: Set<string>;
  /** Names skipped only at the top level (/proc, /sys… when searching the whole computer). */
  skipAtTop?: Set<string>;
}

export interface WalkHit {
  rel: string;
  name: string;
  type: SearchHit["type"];
  size: number | null;
  mtime: number;
  kind: FileKind;
}

export interface WalkResult {
  count: number;
  truncated: boolean;
  timedOut: boolean;
}

/** Walk `fsRoot` (a path this process can open), calling `onBatch` with hits as they're found. */
export function walkTree(fsRoot: string, o: WalkOptions, onBatch: (hits: WalkHit[]) => void): { done: Promise<WalkResult>; stop: () => void } {
  let stopped = false;
  let timedOut = false;
  let truncated = false;
  let count = 0;
  let batch: WalkHit[] = [];
  const flush = () => {
    if (batch.length) onBatch(batch);
    batch = [];
  };
  // A deadline checked as it goes rather than a timer: a timer only fires between I/O callbacks, so a
  // fast walk could finish before it and a slow one would run past it until the next callback.
  const deadline = Date.now() + o.timeoutMs;
  const late = () => {
    if (Date.now() >= deadline) timedOut = stopped = true;
    return stopped;
  };

  const done = (async () => {
    let level: string[] = [""];
    for (let d = 1; d <= o.depth && level.length && !stopped; d++) {
      const next: string[] = [];
      for (const rel of level) {
        if (stopped || late()) break;
        let names: fs.Dirent[];
        try {
          names = await fs.promises.readdir(path.join(fsRoot, rel), { withFileTypes: true });
        } catch {
          continue; // unreadable folder: find reports it on stderr and carries on
        }
        names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const ent of names) {
          if (stopped || late()) break;
          if (o.skipNames.has(ent.name)) continue;
          if (!rel && o.skipAtTop?.has(ent.name)) continue;
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          const dir = ent.isDirectory();
          if (dir) next.push(childRel);
          const type: SearchHit["type"] = dir ? "dir" : ent.isFile() ? "file" : ent.isSymbolicLink() ? "symlink" : "other";
          if (o.type === "file" && type !== "file") continue;
          if (o.type === "dir" && type !== "dir") continue;
          if (o.kinds && (type !== "file" || !o.kinds.has(kindOf(ent.name)))) continue;
          if (o.pattern && !o.pattern.test(ent.name) && !(o.inPath && o.pattern.test(childRel))) continue;
          let st: fs.Stats;
          try {
            st = await fs.promises.lstat(path.join(fsRoot, childRel));
          } catch {
            continue;
          }
          if (o.since && st.mtimeMs < o.since) continue;
          if (o.minSize && (type !== "file" || st.size < o.minSize)) continue;
          batch.push({ rel: childRel, name: ent.name, type, size: type === "file" ? st.size : null, mtime: Math.round(st.mtimeMs), kind: kindOf(ent.name, dir) });
          if (batch.length >= 100) flush();
          if (++count >= o.limit) {
            truncated = true;
            stopped = true;
          }
        }
      }
      level = next;
    }
  })()
    .catch(() => {})
    .then(() => {
      flush();
      return { count, truncated, timedOut };
    });

  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}

/** A find-style name (case-insensitive, `*` and `?` wildcards, otherwise "contains") as a RegExp. */
export function globToRegExp(q: string): RegExp {
  const term = q.trim();
  const body = term.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return /[*?]/.test(term) ? new RegExp(`^${body}$`, "i") : new RegExp(body, "i");
}

// ---------------------------------------------------------------- which engine

export type Engine = "find" | "walk";
type Probe = () => Promise<boolean>;

/** Does this machine's find understand -printf? (GNU find does; BSD and macOS find don't.) */
export function probeFindPrintf(spawnFind: (args: string[]) => ChildProcess): Probe {
  return () =>
    new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnFind([os.tmpdir(), "-maxdepth", "0", "-printf", ""]);
      } catch {
        return resolve(false);
      }
      let err = "";
      child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
      child.stdout?.resume();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 && !err.trim());
      });
    });
}

/**
 * Which engine to use, decided once per chooser. find on Linux, always: the server's GNU find is
 * the fast path and a failed probe must never demote it. Elsewhere find only if it answers -printf.
 */
export function engineChooser(probe: Probe, platform: NodeJS.Platform = process.platform): () => Promise<Engine> {
  let chosen: Promise<Engine> | null = null;
  return () => {
    if (platform === "linux") return Promise.resolve("find");
    chosen ??= probe()
      .then((ok): Engine => (ok ? "find" : "walk"))
      .catch((): Engine => "walk");
    return chosen;
  };
}
