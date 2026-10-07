import "server-only";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AppError } from "../errors";
import type { NextRequest } from "next/server";
import { sse } from "../api";
import { hostPath } from "../host/paths";
import { localSpawn } from "../host/exec";
import type { User } from "../auth/users";
import type { FileKind, SearchHit } from "@/lib/files-types";
import { authorize, LEGACY_TRASH_DIR, TRASH_DIR } from "./paths";
import { engineChooser, globToRegExp, probeFindPrintf, walkTree } from "./walk";
import { displayPath } from "./list";
import { extensionsOf, kindOf } from "./kinds";
import { places } from "./places";

export interface SearchQuery {
  path: string;
  q: string;
  depth?: number;
  type?: "file" | "dir" | "any";
  modifiedWithinDays?: number;
  minSize?: number;
  limit?: number;
  /** Only files of these kinds ("photos and videos"), matched by extension. */
  kinds?: FileKind[];
  /** The name may also match a folder on the way, below `path` ("lisbon" finds the photos in Lisbon 2025). */
  inPath?: boolean;
}

const TIMEOUT_MS = 30_000;
const searchEngine = engineChooser(probeFindPrintf((args) => localSpawn("find", args)));

/** Literal text → a case-insensitive find pattern. `*` and `?` typed by the person stay wildcards. */
export function toPattern(q: string): string {
  const term = q.trim();
  const escaped = term.replace(/[[\]\\]/g, (c) => `\\${c}`);
  return /[*?]/.test(term) ? escaped : `*${escaped}*`;
}

export interface SearchResult {
  count: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Name matches under one folder a person may read, handed over in batches. GNU find on the server
 * (no link following, so results stay inside the folder a member may see); where find has no
 * -printf (a Mac running the dev server) a Node walk with the same rules and limits.
 */
export async function runSearch(user: User, q: SearchQuery, onBatch: (hits: SearchHit[]) => void, signal?: AbortSignal): Promise<SearchResult> {
  const t = await authorize(user, q.path, "read");
  if (!t.stat?.isDirectory()) throw new AppError("not_a_folder", "Search inside a folder.", 400);
  const shown = displayPath(t);
  const root = hostPath(t.real);
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 2000);
  const depth = Math.min(Math.max(q.depth ?? 12, 1), 40);
  const kinds = (q.kinds ?? []).filter((k) => extensionsOf(k).length);
  const wantKind = kinds.length ? new Set<FileKind>(kinds) : null;
  const shownPath = (rel: string) => (shown === "/" ? `/${rel}` : `${shown}/${rel}`);
  if (signal?.aborted) return { count: 0, truncated: false, timedOut: false };

  if ((await searchEngine()) === "walk") {
    const w = walkTree(
      root,
      {
        pattern: q.q.trim() === "*" ? null : globToRegExp(q.q),
        inPath: !!q.inPath && !/[*?]/.test(q.q),
        type: q.type,
        kinds: wantKind,
        since: q.modifiedWithinDays ? Date.now() - Math.ceil(q.modifiedWithinDays) * 86_400_000 : 0,
        minSize: q.minSize,
        depth,
        limit,
        timeoutMs: TIMEOUT_MS,
        skipNames: new Set([TRASH_DIR, LEGACY_TRASH_DIR]),
        skipAtTop: t.real === "/" ? new Set(["proc", "sys", "dev", "run"]) : undefined,
      },
      (hits) => onBatch(hits.map((h) => ({ path: shownPath(h.rel), name: h.name, type: h.type, size: h.size, mtime: h.mtime, kind: h.kind }))),
    );
    signal?.addEventListener("abort", w.stop, { once: true });
    try {
      return await w.done;
    } finally {
      signal?.removeEventListener("abort", w.stop);
    }
  }

  const prunes = ["-name", TRASH_DIR, "-o", "-name", LEGACY_TRASH_DIR];
  if (t.real === "/") for (const p of ["/proc", "/sys", "/dev", "/run", "/var/lib/docker", "/var/lib/containerd"]) prunes.push("-o", "-path", hostPath(p));
  const any = q.q.trim() === "*";
  const globRoot = root.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
  const match = any && wantKind ? [] : q.inPath && !any && !/[*?]/.test(q.q) ? ["(", "-iname", toPattern(q.q), "-o", "-ipath", `${globRoot}/*${toPattern(q.q)}`, ")"] : ["-iname", toPattern(q.q)];
  if (wantKind) {
    const exts = kinds.flatMap(extensionsOf);
    match.push("(", ...exts.flatMap((e, n) => (n ? ["-o", "-iname", `*.${e}`] : ["-iname", `*.${e}`])), ")", "-type", "f");
  }
  if (q.type === "file") match.push("-type", "f");
  if (q.type === "dir") match.push("-type", "d");
  if (q.modifiedWithinDays) match.push("-mtime", `-${Math.ceil(q.modifiedWithinDays)}`);
  if (q.minSize) match.push("-size", `+${Math.max(0, Math.floor(q.minSize) - 1)}c`);
  const args = [root, "-mindepth", "1", "-maxdepth", String(depth), "(", ...prunes, ")", "-prune", "-o", "(", ...match, ")", "-printf", "%y\\t%s\\t%T@\\t%P\\0"];

  return new Promise<SearchResult>((resolve) => {
    const child = localSpawn("find", args);
    let buf = "";
    const decoder = new StringDecoder("utf8");
    let count = 0;
    let truncated = false;
    let timedOut = false;
    let batch: SearchHit[] = [];
    let finished = false;
    const flush = () => {
      if (batch.length) onBatch(batch);
      batch = [];
    };
    const flushTimer = setInterval(flush, 150);
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(flushTimer);
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      flush();
      resolve({ count, truncated, timedOut });
    };
    child.stdout!.on("data", (b: Buffer) => {
      buf += decoder.write(b);
      let i: number;
      while ((i = buf.indexOf("\0")) >= 0) {
        const rec = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const [y, s, m, rel] = rec.split("\t");
        if (!rel) continue;
        const type = y === "d" ? "dir" : y === "f" ? "file" : y === "l" ? "symlink" : "other";
        const name = path.posix.basename(rel);
        if (wantKind && !wantKind.has(kindOf(name))) continue;
        batch.push({ path: shownPath(rel), name, type, size: type === "file" ? Number(s) : null, mtime: Math.round(Number(m) * 1000), kind: kindOf(name, type === "dir") });
        if (batch.length >= 100) flush();
        if (++count >= limit) {
          truncated = true;
          kill();
          break;
        }
      }
    });
    child.stderr!.resume(); // permission-denied noise
    child.on("close", finish);
    child.on("error", finish);
  });
}

/**
 * Several roots searched at once, sharing one limit (the first `limit` hits win, the rest stop).
 * A root that can't be searched is skipped; when none can, the first reason is thrown.
 */
export async function runSearchMany(user: User, roots: string[], q: Omit<SearchQuery, "path">, onBatch: (hits: SearchHit[]) => void, signal?: AbortSignal): Promise<SearchResult> {
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 2000);
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const seen = new Set<string>();
  let count = 0;
  let truncated = false;
  let timedOut = false;
  const errors: unknown[] = [];
  try {
    await Promise.all(
      [...new Set(roots)].map((path) =>
        runSearch(
          user,
          { ...q, path, limit },
          (batch) => {
            const fresh = batch.filter((h) => !seen.has(h.path) && seen.add(h.path)).slice(0, Math.max(0, limit - count));
            count += fresh.length;
            if (fresh.length) onBatch(fresh);
            if (count >= limit) {
              truncated = true;
              ctrl.abort();
            }
          },
          ctrl.signal,
        ).then(
          (r) => {
            truncated ||= r.truncated;
            timedOut ||= r.timedOut;
          },
          (e: unknown) => void errors.push(e),
        ),
      ),
    );
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (errors.length && errors.length === new Set(roots).size) throw errors[0];
  return { count, truncated, timedOut };
}

/** SSE over one or several roots: "hits" { items } batches, then "done" { count, truncated, timedOut }. */
export function searchStream(req: NextRequest, user: User, roots: string[], q: Omit<SearchQuery, "path">): Response {
  return sse(req, async (send, close) => {
    const ctrl = new AbortController();
    void runSearchMany(user, roots, q, (items) => send("hits", { items }), ctrl.signal)
      .then((r) => send("done", r))
      .catch((e: unknown) => send("error", { message: e instanceof AppError ? e.message : "The search stopped. Try again." }))
      .finally(close);
    return () => ctrl.abort();
  });
}

/** Where a person keeps files: shares for members; homes, drives and app folders for admins (not the OS). */
async function searchRoots(user: User): Promise<string[]> {
  const p = await places(user);
  const list = p.places.filter((pl) => !pl.missing && pl.kind !== "root" && (pl.kind !== "drive" || pl.fs)).map((pl) => pl.path);
  return list.filter((a) => !list.some((b) => b !== a && a.startsWith(`${b}/`)));
}

/**
 * Names matching `q` in the folders this person may use (all of them when `root` is null), for
 * universal search. Same engine and permission checks as Files' own search; stops at `limit`.
 */
export async function searchNames(user: User, root: string | null, q: string, opts: { limit?: number; signal?: AbortSignal; depth?: number; type?: "file" | "dir" | "any" } = {}): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 500);
  const roots = root ? [root] : await searchRoots(user);
  const hits: SearchHit[] = [];
  await runSearchMany(user, roots, { q, limit, depth: opts.depth ?? 8, type: opts.type ?? "any" }, (batch) => void hits.push(...batch), opts.signal).catch(() => null);
  return hits;
}
