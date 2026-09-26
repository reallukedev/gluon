import "server-only";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AppError } from "../errors";
import type { NextRequest } from "next/server";
import { sse } from "../api";
import { hostPath } from "../host/paths";
import { localSpawn } from "../host/exec";
import type { User } from "../auth/users";
import type { SearchGroup } from "../search";
import type { SearchHit } from "@/lib/files-types";
import { authorize, LEGACY_TRASH_DIR, TRASH_DIR } from "./paths";
import { displayPath } from "./list";
import { kindOf } from "./kinds";
import { places } from "./places";

export interface SearchQuery {
  path: string;
  q: string;
  depth?: number;
  type?: "file" | "dir" | "any";
  modifiedWithinDays?: number;
  minSize?: number;
  limit?: number;
}

const TIMEOUT_MS = 30_000;

/** Literal text → a case-insensitive find pattern. `*` and `?` typed by the person stay wildcards. */
export function toPattern(q: string): string {
  const term = q.trim();
  const escaped = term.replace(/[[\]\\]/g, (c) => `\\${c}`);
  return /[*?]/.test(term) ? escaped : `*${escaped}*`;
}

/**
 * Stream name matches under a folder with `find` (no link following, so results stay inside the
 * folder a member may see). Events: "hits" { items }, then "done" { count, truncated, timedOut }.
 */
export function searchStream(req: NextRequest, user: User, q: SearchQuery): Response {
  return sse(req, async (send, close) => {
    const t = await authorize(user, q.path, "read");
    if (!t.stat?.isDirectory()) throw new AppError("not_a_folder", "Search inside a folder.", 400);
    const shown = displayPath(t);
    const root = hostPath(t.real);
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 2000);
    const depth = Math.min(Math.max(q.depth ?? 12, 1), 40);

    const prunes = ["-name", TRASH_DIR, "-o", "-name", LEGACY_TRASH_DIR];
    if (t.real === "/") for (const p of ["/proc", "/sys", "/dev", "/run", "/var/lib/docker", "/var/lib/containerd"]) prunes.push("-o", "-path", hostPath(p));
    const match = ["-iname", toPattern(q.q)];
    if (q.type === "file") match.push("-type", "f");
    if (q.type === "dir") match.push("-type", "d");
    if (q.modifiedWithinDays) match.push("-mtime", `-${Math.ceil(q.modifiedWithinDays)}`);
    if (q.minSize) match.push("-size", `+${Math.max(0, Math.floor(q.minSize) - 1)}c`);
    const args = [root, "-mindepth", "1", "-maxdepth", String(depth), "(", ...prunes, ")", "-prune", "-o", "(", ...match, ")", "-printf", "%y\\t%s\\t%T@\\t%P\\0"];

    const child = localSpawn("find", args);
    let buf = "";
    const decoder = new StringDecoder("utf8");
    let count = 0;
    let truncated = false;
    let timedOut = false;
    let batch: SearchHit[] = [];
    let finished = false;
    const flush = () => {
      if (batch.length) send("hits", { items: batch });
      batch = [];
    };
    const flushTimer = setInterval(flush, 150);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(flushTimer);
      clearTimeout(timer);
      flush();
      send("done", { count, truncated, timedOut });
      close();
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
        batch.push({
          path: shown === "/" ? `/${rel}` : `${shown}/${rel}`,
          name,
          type,
          size: type === "file" ? Number(s) : null,
          mtime: Math.round(Number(m) * 1000),
          kind: kindOf(name, type === "dir"),
        });
        if (batch.length >= 100) flush();
        if (++count >= limit) {
          truncated = true;
          child.kill("SIGKILL");
          break;
        }
      }
    });
    child.stderr!.resume(); // permission-denied noise
    child.on("close", finish);
    child.on("error", finish);
    return () => {
      finished = true;
      clearInterval(flushTimer);
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
  });
}

// ---------------------------------------------------------------- ⌘K

/** Pinned folders, places and recent folders whose name or path matches. */
export async function searchProvider(user: User, q: string): Promise<SearchGroup | null> {
  const term = q.toLowerCase();
  const p = await places(user);
  const seen = new Set<string>();
  const items: SearchGroup["items"] = [];
  const consider = (label: string, target: string, hint: string) => {
    if (seen.has(target)) return;
    if (!label.toLowerCase().includes(term) && !target.toLowerCase().includes(term)) return;
    seen.add(target);
    items.push({ id: `folder:${target}`, label, hint, icon: "folder", href: `/files?path=${encodeURIComponent(target)}` });
  };
  for (const pin of p.pins) if (!pin.missing) consider(pin.label, pin.path, `Pinned · ${pin.path}`);
  for (const pl of p.places) if (!pl.missing) consider(pl.label, pl.path, pl.kind === "media" && pl.apps?.length ? `Used by ${pl.apps.slice(0, 2).join(", ")} · ${pl.path}` : pl.path);
  for (const r of p.recent) consider(r.label, r.path, `Recent · ${r.path}`);
  if (!items.length) return null;
  return { name: "Folders", items: items.slice(0, 8) };
}
