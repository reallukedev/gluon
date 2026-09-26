import "server-only";
import fs from "node:fs";
import { hostPath } from "../host/paths";

/** uid/gid → name from the host's /etc/passwd and /etc/group, re-read when the files change. */

interface Table {
  mtime: number;
  byId: Map<number, string>;
  byName: Map<string, number>;
}

const tables: Record<"passwd" | "group", Table | null> = { passwd: null, group: null };
let checkedAt = 0;

function load(kind: "passwd" | "group"): Table {
  const file = hostPath(`/etc/${kind}`);
  const cur = tables[kind];
  // stat at most once a second across both files.
  if (cur && Date.now() - checkedAt < 1000) return cur;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return cur ?? { mtime: 0, byId: new Map(), byName: new Map() };
  }
  if (cur && cur.mtime === mtime) return cur;
  const byId = new Map<number, string>();
  const byName = new Map<string, number>();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const f = line.split(":");
      const name = f[0];
      const id = Number(f[2]);
      if (!name || !Number.isInteger(id)) continue;
      if (!byId.has(id)) byId.set(id, name);
      if (!byName.has(name)) byName.set(name, id);
    }
  } catch {
    /* unreadable: names stay unknown */
  }
  const t = { mtime, byId, byName };
  tables[kind] = t;
  return t;
}

function touch() {
  load("passwd");
  load("group");
  checkedAt = Date.now();
}

export function userName(uid: number): string | null {
  touch();
  return tables.passwd?.byId.get(uid) ?? null;
}

export function groupName(gid: number): string | null {
  touch();
  return tables.group?.byId.get(gid) ?? null;
}

export function uidOf(name: string): number | null {
  touch();
  return tables.passwd?.byName.get(name) ?? null;
}

export function gidOf(name: string): number | null {
  touch();
  return tables.group?.byName.get(name) ?? null;
}

/** "drwxr-xr-x" from a stat mode. */
export function modeString(mode: number): string {
  const t = mode & 0o170000;
  const type = t === 0o040000 ? "d" : t === 0o120000 ? "l" : t === 0o020000 ? "c" : t === 0o060000 ? "b" : t === 0o010000 ? "p" : t === 0o140000 ? "s" : "-";
  const bits = (n: number, s: number, x: string, X: string) =>
    `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${s ? (n & 1 ? x : X) : n & 1 ? "x" : "-"}`;
  return (
    type +
    bits((mode >> 6) & 7, mode & 0o4000, "s", "S") +
    bits((mode >> 3) & 7, mode & 0o2000, "s", "S") +
    bits(mode & 7, mode & 0o1000, "t", "T")
  );
}
