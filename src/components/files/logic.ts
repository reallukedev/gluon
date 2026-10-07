// Pure rules behind the Files screens: reading what's typed into the command bar, completing
// paths, filtering and sorting, which actions a person may see, and how folders are laid out.
// No React and no network here, so all of it is tested directly (logic.test.ts).

import type { ConflictPolicy, FileKind, Place, Places } from "@/lib/files-types";

// ---------------------------------------------------------------- the command bar

export type Token = { type: "kind"; kind: FileKind; label: string } | { type: "time"; days: number; label: string } | { type: "size"; bytes: number };

export type Parsed =
  | { mode: "empty" }
  | { mode: "path"; text: string }
  | { mode: "action"; text: string }
  | { mode: "dest"; verb: "move" | "copy"; text: string }
  | { mode: "find"; name: string; kinds: FileKind[]; days: number | null; minSize: number | null; tokens: Token[] };

/** Words people type for a kind of file, and what the bar calls it back to them. */
const KIND_WORDS: [RegExp, FileKind, string][] = [
  [/^(photos?|pictures?|images?|pics)$/, "image", "Photos"],
  [/^(videos?|films?|movies?)$/, "video", "Videos"],
  [/^(music|songs?|audio|tracks?)$/, "audio", "Music"],
  [/^(docs?|documents?|pdfs?)$/, "document", "Documents"],
  [/^(archives?|zips?)$/, "archive", "Archives"],
  [/^(configs?|code|scripts?)$/, "text", "Text and code"],
  [/^(isos?)$/, "disk-image", "Disk images"],
];
const TIME_WORDS: [RegExp, number, string][] = [
  [/^today$/, 1, "Changed today"],
  [/^yesterday$/, 2, "Since yesterday"],
  [/^(week|7d)$/, 7, "This week"],
  [/^recent(ly)?$/, 14, "Last two weeks"],
  [/^(month|30d)$/, 31, "This month"],
  [/^year$/, 365, "This year"],
];
const FILLER = new Set(["this", "from", "in", "the", "all", "my", "last", "past", "of", "files", "file", "than", "over", "bigger", "and"]);
// Decimal, like every size Gluon shows, so "over 1 GB" reads back as 1 GB.
const UNIT: Record<string, number> = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
/** ">1gb", ">500mb", or "over1gb" (what the quick filter types, so it never reads as an action). */
const SIZE_WORD = /^(?:>|over)(\d+(?:\.\d+)?)([kmgt])b?$/;

/**
 * What the bar should do with the text: a path (starts with / or ~), actions (starts with >), a
 * destination ("move to …" with something selected), or a search, with words like "photos",
 * "this week" or ">1gb" read as filters and the rest as part of a name.
 */
export function parseCommand(raw: string, hasSelection: boolean, home?: string | null): Parsed {
  const text = raw.trimStart();
  if (!text) return { mode: "empty" };
  if (text.startsWith("/")) return { mode: "path", text };
  if (text.startsWith("~") && home) return { mode: "path", text: home + text.slice(1) };
  // ">" lists actions, except ">1gb" and the like, which is a size to search for.
  if (text.startsWith(">") && !SIZE_WORD.test(text.split(/\s+/)[0]!.toLowerCase())) return { mode: "action", text: text.slice(1).trim() };
  // "move to …" always names a destination, even before anything is selected (the bar then asks
  // for a selection) and even when the folder's name is a filter word like "movies".
  const dest = /^(move|copy)\s+to(?:\s+(.*))?$/i.exec(text) ?? (hasSelection ? /^(mv|cp|move|copy)(?:\s+(.*))?$/i.exec(text) : null);
  if (dest) return { mode: "dest", verb: /^(move|mv)$/i.test(dest[1]!) ? "move" : "copy", text: (dest[2] ?? "").trim() };
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const kinds: FileKind[] = [];
  const tokens: Token[] = [];
  let days: number | null = null;
  let minSize: number | null = null;
  const rest: string[] = [];
  for (const w of words) {
    const k = KIND_WORDS.find(([re]) => re.test(w));
    if (k) {
      if (!kinds.includes(k[1])) {
        kinds.push(k[1]);
        tokens.push({ type: "kind", kind: k[1], label: k[2] });
      }
      continue;
    }
    const t = TIME_WORDS.find(([re]) => re.test(w));
    if (t) {
      days = t[1];
      tokens.push({ type: "time", days: t[1], label: t[2] });
      continue;
    }
    const size = SIZE_WORD.exec(w);
    if (size || /^(big|large|huge)$/.test(w)) {
      minSize = size ? Number(size[1]) * UNIT[size[2]!]! : 1e9;
      tokens.push({ type: "size", bytes: minSize });
      continue;
    }
    rest.push(w);
  }
  const name = (tokens.length ? rest.filter((w) => !FILLER.has(w)) : rest).join(" ");
  return { mode: "find", name, kinds, days, minSize, tokens };
}

/** Add or remove a filter word in what's typed (the quick filters under the bar do this). */
export function toggleWord(text: string, word: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => w.toLowerCase() === word.toLowerCase());
  if (i >= 0) words.splice(i, 1);
  else words.push(word);
  return words.join(" ") + (words.length ? " " : "");
}

export function hasWord(text: string, word: string): boolean {
  return text
    .toLowerCase()
    .split(/\s+/)
    .includes(word.toLowerCase());
}

// ---------------------------------------------------------------- paths

/** "/home/luke/Pi" → the folder to list (/home/luke) and what to complete in it ("pi"). */
export function splitTypedPath(text: string): { dir: string; stem: string } {
  if (text.endsWith("/")) return { dir: text.replace(/\/+$/, "") || "/", stem: "" };
  const i = text.lastIndexOf("/");
  return { dir: i <= 0 ? "/" : text.slice(0, i), stem: text.slice(i + 1).toLowerCase() };
}

/** Folder names that complete a stem: those starting with it first, then those containing it. */
export function rankCompletions(names: string[], stem: string, limit = 40): string[] {
  const s = stem.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(s));
  const inside = s ? names.filter((n) => !n.toLowerCase().startsWith(s) && n.toLowerCase().includes(s)) : [];
  return [...starts, ...inside].slice(0, limit);
}

export function joinPath(dir: string, name: string) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
export function parentOf(p: string): string {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** The folders drawn as columns: from the place the path is in, down to the path itself. */
export function columnsFor(path: string, places: Pick<Places, "places"> | undefined, admin: boolean): string[] {
  const roots = (places?.places ?? []).filter((p) => !p.missing && p.kind !== "root").map((p) => p.path);
  const inside = roots.filter((r) => path === r || path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length);
  const root = inside[0] ?? (admin ? "/" : path);
  const out = [root];
  if (path !== root) {
    let acc = root === "/" ? "" : root;
    for (const part of path.slice(root === "/" ? 1 : root.length + 1).split("/")) {
      acc += `/${part}`;
      out.push(acc);
    }
  }
  return out;
}

// ---------------------------------------------------------------- filtering and sorting

export interface Filterable {
  name: string;
  path: string;
  kind: FileKind;
  mtime: number;
  size: number | null;
}
export interface Filter {
  name: string;
  kinds: FileKind[];
  days: number | null;
  minSize: number | null;
}

/**
 * Does an item match? The name may also match a folder on the way (from `under`), so
 * "lisbon photos" finds the photos in "Lisbon 2025" even when no photo has lisbon in its name.
 */
export function matches(e: Filterable, f: Filter, now: number, under?: string): boolean {
  if (f.kinds.length && !f.kinds.includes(e.kind)) return false;
  if (f.days && e.mtime < now - f.days * 86_400_000) return false;
  if (f.minSize && (e.size ?? 0) < f.minSize) return false;
  if (!f.name) return true;
  const n = f.name.toLowerCase();
  if (e.name.toLowerCase().includes(n)) return true;
  const hasFilters = f.kinds.length > 0 || !!f.days || !!f.minSize;
  if (!hasFilters || !under) return false;
  return e.path.slice(under.length).toLowerCase().includes(n);
}

export type SortBy = "name" | "mtime" | "size";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sort search hits the way the folders are sorted: folders first, then by the key. */
export function sortItems<T extends { name: string; mtime: number; size: number | null; kind: FileKind }>(items: T[], by: SortBy, order: "asc" | "desc"): T[] {
  const dir = order === "asc" ? 1 : -1;
  return items.toSorted((a, b) => {
    const fa = a.kind === "folder" ? 0 : 1;
    const fb = b.kind === "folder" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const c = (by === "mtime" ? a.mtime - b.mtime : by === "size" ? (a.size ?? -1) - (b.size ?? -1) : collator.compare(a.name, b.name)) * dir;
    return c || collator.compare(a.name, b.name);
  });
}

// ---------------------------------------------------------------- what a person may do

export type CommandId =
  | "download"
  | "zip"
  | "move"
  | "copy"
  | "rename"
  | "duplicate"
  | "cut"
  | "copy-clip"
  | "paste"
  | "pin"
  | "extract"
  | "copy-path"
  | "properties"
  | "used-by"
  | "ownership"
  | "measure"
  | "trash"
  | "new-folder"
  | "new-file"
  | "upload"
  | "upload-folder"
  | "up"
  | "hidden"
  | "sort-name"
  | "sort-mtime"
  | "sort-size"
  | "sort-kind"
  | "view-columns"
  | "view-list"
  | "view-grid"
  | "pin-here"
  | "path-here"
  | "props-here"
  | "trash-view"
  | "keys";

export interface CommandContext {
  /** How many things are selected, and what the single one is when there's one. */
  count: number;
  oneIsDir: boolean;
  oneIsArchive: boolean;
  /** The folder being shown can be changed by this person. */
  writable: boolean;
  admin: boolean;
  inFolder: boolean;
  hasParent: boolean;
  clipboard: boolean;
}

/** The actions on offer right now, in the order people look for them. Members never see admin tools. */
export function commandIds(c: CommandContext): CommandId[] {
  const out: CommandId[] = [];
  const one = c.count === 1;
  if (c.count) {
    out.push(c.count > 1 || c.oneIsDir ? "zip" : "download");
    if (c.writable) out.push("move");
    out.push("copy");
    if (c.writable && one) out.push("rename");
    if (c.writable) out.push("duplicate", "cut");
    out.push("copy-clip");
    if (one && c.oneIsDir) out.push("pin", "measure");
    if (one && c.oneIsArchive && c.writable) out.push("extract");
    if (one) out.push("copy-path", "properties");
    if (one && c.oneIsDir && c.admin) out.push("used-by", "ownership");
    if (c.writable) out.push("trash");
  }
  if (c.inFolder) {
    if (c.writable) {
      if (c.clipboard) out.push("paste");
      out.push("new-folder", "new-file", "upload", "upload-folder");
    }
    if (c.hasParent) out.push("up");
    out.push("view-columns", "view-list", "view-grid", "hidden", "sort-name", "sort-mtime", "sort-size", "sort-kind", "pin-here", "path-here", "props-here");
    if (c.admin && !c.count) out.push("measure");
  }
  out.push("trash-view", "keys");
  return [...new Set(out)];
}

// ---------------------------------------------------------------- places

export type PlaceGroup = "shared" | "pins" | "drives" | "people" | "apps" | "recent";

/**
 * Places grouped for the rail and the front page. Members see what's shared with them and their
 * own pins; drives, everyone's home folders and app folders are for admins.
 */
export function groupPlaces(p: Places | undefined): [PlaceGroup, Place[]][] {
  if (!p) return [];
  const live = (l: Place[]) => l.filter((x) => !x.missing || x.kind === "drive" || x.kind === "grant");
  const groups: [PlaceGroup, Place[]][] = [
    ["shared", live(p.places.filter((x) => x.kind === "grant"))],
    ["pins", p.pins],
  ];
  if (p.admin) {
    groups.push(["drives", p.places.filter((x) => x.kind === "drive" || x.kind === "root")]);
    groups.push(["people", p.places.filter((x) => x.kind === "home")]);
    groups.push(["apps", p.places.filter((x) => x.kind === "media" || x.kind === "data")]);
  }
  groups.push(["recent", p.recent.slice(0, 5)]);
  return groups.filter(([, l]) => l.length);
}

/** Where a usage bar stands: sodium past 85% (needs you soon), red past 95% (nearly full). */
export function fullness(used: number, size: number): "normal" | "attention" | "fault" {
  if (!size) return "normal";
  const pct = (used / size) * 100;
  return pct >= 95 ? "fault" : pct >= 85 ? "attention" : "normal";
}

// ---------------------------------------------------------------- how a folder is shown

export type FolderView = "columns" | "list" | "grid";

/** A remembered choice wins; otherwise a folder that's mostly photos opens as a grid. */
export function viewFor(remembered: FolderView | undefined, files: { kind: FileKind }[]): FolderView {
  if (remembered) return remembered;
  const photos = files.filter((f) => f.kind === "image" || f.kind === "video").length;
  return files.length >= 24 && photos / files.length >= 0.6 ? "grid" : "columns";
}

/** Keep the remembered views small: the newest choices, at most `max`. */
export function rememberView(map: Record<string, FolderView>, path: string, view: FolderView, max = 200): Record<string, FolderView> {
  const next: Record<string, FolderView> = { ...map };
  delete next[path];
  next[path] = view;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete next[k];
  return next;
}

/** Times in the future (a clock that's off, a file from another machine) read as a date, not "in 19 hours". */
export function timeKind(ts: number, now: number): "relative" | "dateTime" {
  return ts > now + 60_000 ? "dateTime" : "relative";
}

// ---------------------------------------------------------------- uploads

export interface UploadPick {
  /** Folder path inside what was dropped ("" for a loose file). */
  rel: string;
  name: string;
  size: number;
}

/** What lands at the top of the destination: loose files, and dropped folders (even empty ones). */
export function uploadTops(files: UploadPick[], dirs: string[]): Map<string, { isDir: boolean; size: number | null }> {
  const tops = new Map<string, { isDir: boolean; size: number | null }>();
  for (const f of files) {
    const top = f.rel ? f.rel.split("/")[0]! : f.name;
    tops.set(top, { isDir: !!f.rel, size: f.rel ? null : f.size });
  }
  for (const d of dirs) if (!d.includes("/")) tops.set(d, { isDir: true, size: null });
  return tops;
}

/**
 * Where everything goes once the clashes are answered. A clashing folder is skipped, merged
 * (files with the same names are replaced, the old ones go to the trash) or kept beside the old
 * one as "Name (2)", where its files use "rename". Loose files take their
 * own answer. Folders are listed parents first, ready to create.
 */
export function planUpload(files: UploadPick[], dirs: string[], taken: Set<string>, answers: Map<string, ConflictPolicy>): { dirs: string[]; files: { index: number; dir: string; conflict: ConflictPolicy }[] } {
  const topRename = new Map<string, string>();
  for (const [n, t] of uploadTops(files, dirs)) {
    if (!t.isDir) continue;
    const a = answers.get(n);
    if (a === "skip") topRename.set(n, "");
    else if (a === "rename") {
      let i = 2;
      while (taken.has(`${n} (${i})`)) i++;
      topRename.set(n, `${n} (${i})`);
    } else topRename.set(n, n);
  }
  const mapRel = (rel: string): string | null => {
    if (!rel) return rel;
    const [top, ...rest] = rel.split("/");
    const to = topRename.get(top!) ?? top!;
    return to ? [to, ...rest].join("/") : null;
  };
  const outDirs = [...new Set(dirs.map(mapRel).filter((d): d is string => !!d))].sort((a, b) => a.split("/").length - b.split("/").length);
  const out: { index: number; dir: string; conflict: ConflictPolicy }[] = [];
  files.forEach((f, index) => {
    if (!f.rel) {
      const a = answers.get(f.name);
      if (a !== "skip") out.push({ index, dir: "", conflict: a ?? "rename" });
      return;
    }
    const rel = mapRel(f.rel);
    if (rel === null) return;
    const top = f.rel.split("/")[0]!;
    // Merging into a folder that's there replaces same-named files; a new or renamed folder can't clash.
    out.push({ index, dir: rel, conflict: topRename.get(top) === top ? "overwrite" : "rename" });
  });
  return { dirs: outDirs, files: out };
}

/** Indexes from `a` to `b` inclusive, either way round. */
export function rangeOf(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  return Array.from({ length: Math.abs(a - b) + 1 }, (_, i) => lo + i);
}
