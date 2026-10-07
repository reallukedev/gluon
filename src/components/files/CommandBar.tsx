"use client";
import * as React from "react";
import { AppWindow, Archive, Check, Copy, DataTransferBoth, Download, EditPencil, Eye, EyeClosed, PinSlash, FolderPlus, InfoCircle, KeyCommand, Link, List, MultiplePages, NavArrowRight, NavArrowUp, PagePlus, PasteClipboard, Pin, Refresh, Scissor, Search, SortDown, SortUp, Trash, Upload, UserCrown, ViewColumns3, ViewGrid, Xmark } from "iconoir-react";
import type { FileEntry, Listing as ListingT, Place, Places, SearchHit } from "@/lib/files-types";
import { useApi } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { IconButton } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";
import type { FileActions } from "./actions";
import { collectionRoots, placeList, useFileSearch, type SearchSpec, type SearchState } from "./hooks";
import { commandIds, hasWord, joinPath, matches, parentOf, parseCommand, sortItems, rankCompletions, splitTypedPath, toggleWord, type CommandId, type Parsed } from "./logic";
import type { BrowserApi } from "./Browser";
import type { Screen, Selected } from "./Files";
import { useBarState, useFiles } from "./Files";
import { FileTime } from "./FileTime";
import { KindIcon, PlaceIcon, baseName, isArchive, isDirLike, modKey, newFolderHint, useMediaQuery, useModKey } from "./lib";
import { Thumb } from "./Thumb";
import { useClip } from "./clip";
import s from "./bar.module.css";

// The command bar: one line on every Files screen. Typing finds (here and in every folder inside,
// or everywhere), a path jumps (with completion), ">" lists what you can do to the selection, and
// "move to …" picks a destination. Results replace the screen until Esc.

type CmdGroup = "Selection" | "This folder" | "View" | "Sort" | "Files";
const GROUPS: CmdGroup[] = ["Selection", "This folder", "View", "Sort", "Files"];

interface Cmd {
  id: CommandId;
  group: CmdGroup;
  icon: React.ReactNode;
  label: string;
  words: string;
  hint?: string;
  danger?: boolean;
  /** Keep the bar open with this text instead of closing (move to …). */
  next?: string;
  run: () => void;
}

export type Item =
  | { key: string; type: "entry"; entry: FileEntry }
  | { key: string; type: "hit"; hit: SearchHit }
  | { key: string; type: "place"; place: Place }
  | { key: string; type: "cmd"; cmd: Cmd }
  | { key: string; type: "dest"; path: string; label: string; detail: string }
  | { key: string; type: "folder"; path: string; name: string; exact?: boolean }
  | { key: string; type: "everywhere"; q: string };

interface Section {
  title: string;
  meta?: React.ReactNode;
  items: Item[];
  /** What to say while it's empty. */
  empty?: string;
}

export interface CommandState {
  text: string;
  setText: (t: string) => void;
  parsed: Parsed;
  /** Something is typed and the results panel is showing. */
  active: boolean;
  setOpen: (o: boolean) => void;
  everywhere: boolean;
  setEverywhere: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  focus: (prefill?: string) => void;
  sections: Section[];
  flat: Item[];
  index: number;
  setIndex: (i: number) => void;
  run: (it: Item, how?: "open" | "look") => void;
  found: SearchState;
  searching: boolean;
  scope: string;
}

/** Actions that act on what's selected (the rest act on the folder you're in). */
const SELECTION_IDS = new Set<CommandId>(["download", "zip", "move", "copy", "rename", "duplicate", "cut", "copy-clip", "pin", "extract", "copy-path", "properties", "used-by", "ownership", "measure", "trash"]);

/** The same icons the menus use, so an action looks the same wherever it's offered. */
const ICONS: Partial<Record<CommandId, React.ReactNode>> = {
  download: <Download />,
  zip: <Download />,
  move: <DataTransferBoth />,
  copy: <Copy />,
  rename: <EditPencil />,
  duplicate: <MultiplePages />,
  cut: <Scissor />,
  "copy-clip": <Copy />,
  pin: <Pin />,
  extract: <Archive />,
  "copy-path": <Link />,
  properties: <InfoCircle />,
  "used-by": <AppWindow />,
  ownership: <UserCrown />,
  measure: <Refresh />,
  trash: <Trash />,
  paste: <PasteClipboard />,
  "new-folder": <FolderPlus />,
  "new-file": <PagePlus />,
  upload: <Upload />,
  "upload-folder": <Upload />,
  up: <NavArrowUp />,
  "view-columns": <ViewColumns3 />,
  "view-list": <List />,
  "view-grid": <ViewGrid />,
  hidden: <Eye />,
  "sort-name": <SortUp />,
  "sort-mtime": <SortDown />,
  "sort-size": <SortDown />,
  "sort-kind": <SortUp />,
  "pin-here": <Pin />,
  "path-here": <Link />,
  "props-here": <InfoCircle />,
  "trash-view": <Trash />,
  keys: <KeyCommand />,
};

const QUICK: { word: string; label: string }[] = [
  { word: "photos", label: "Photos" },
  { word: "videos", label: "Videos" },
  { word: "music", label: "Music" },
  { word: "documents", label: "Documents" },
  { word: "week", label: "This week" },
  { word: "over1gb", label: "Over 1 GB" },
];

export function useCommand(c: {
  screen: Screen;
  path: string | null;
  here: ListingT | undefined;
  selection: Selected;
  places: Places | undefined;
  actions: FileActions;
  go: (p: string | null, o?: { select?: string; replace?: boolean }) => void;
  browser: React.RefObject<BrowserApi | null>;
  admin: boolean;
  showKeys: () => void;
  look: (e: FileEntry, siblings?: (FileEntry | SearchHit)[]) => void;
  lookHit: (h: SearchHit, siblings?: SearchHit[]) => void;
}): CommandState {
  const fmt = useFormat();
  const { prefs, setPrefs } = usePrefs();
  const [text, setTextRaw] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const [everywhere, setEverywhere] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const setText = React.useCallback((t: string) => {
    setTextRaw(t);
    setIndex(0);
    setOpen(true);
  }, []);
  React.useEffect(() => {
    setTextRaw("");
    setEverywhere(false);
  }, [c.path, c.screen]);

  const sel = c.selection.entries;
  const held = useClip();
  const parsed = React.useMemo(() => parseCommand(text, sel.length > 0), [text, sel.length]);
  const here = c.here && c.here.path === c.path ? c.here : undefined;
  const writable = !!here && here.access === "write" && !here.protectedReason;
  const browsing = c.screen === "browse" && !!c.path;
  const scope = browsing && !everywhere ? c.path! : null;

  // ---- what can be done right now
  const commands: Cmd[] = React.useMemo(() => {
    const one = sel.length === 1 ? sel[0]! : null;
    const n = sel.length;
    const what = one ? one.name : fmt.plural(n, "item");
    const paths = sel.map((e) => e.path);
    const b = () => c.browser.current;
    const ids = commandIds({
      count: n,
      oneIsDir: !!one && isDirLike(one),
      oneIsArchive: !!one && !isDirLike(one) && isArchive(one.name),
      writable: sel.length ? c.selection.writable : writable,
      admin: c.admin,
      inFolder: browsing && !!here,
      hasParent: !!here?.parent,
      clipboard: !!held,
    }).filter((id) => (browsing ? true : id === "trash-view" || id === "keys"));
    const mod = modKey();
    const dir = c.selection.dir ?? here?.path ?? "/";
    const all: Partial<Record<CommandId, Omit<Cmd, "id" | "group" | "icon">>> = {
      download: { label: `Download ${what}`, words: "download save get", run: () => void c.actions.download(sel) },
      zip: { label: `Download ${what} as a zip`, words: "download zip save get", run: () => void c.actions.download(sel) },
      move: { label: `Move ${what} to…`, words: "move mv put", hint: "move to …", next: "move to ", run: () => undefined },
      copy: { label: `Copy ${what} to…`, words: "copy cp", hint: "copy to …", next: "copy to ", run: () => undefined },
      rename: { label: `Rename ${what}`, words: "rename name", hint: "F2", run: () => one && b()?.rename(one.path) },
      duplicate: { label: `Duplicate ${what}`, words: "duplicate copy", hint: `${mod}D`, run: () => void c.actions.transfer(paths, dir, "copy") },
      cut: { label: `Cut ${what}`, words: "cut clipboard", hint: `${mod}X`, run: () => c.actions.toClipboard("cut", sel, dir) },
      "copy-clip": { label: `Copy ${what} to paste elsewhere`, words: "copy clipboard", hint: `${mod}C`, run: () => c.actions.toClipboard("copy", sel, dir) },
      pin: { label: one?.pinned ? `Unpin ${what}` : `Pin ${what}`, words: "pin favourite star", run: () => one && void c.actions.togglePin(one) },
      extract: { label: `Extract ${what} here`, words: "extract unzip unpack", run: () => one && void c.actions.extract(one) },
      "copy-path": { label: `Copy the path of ${what}`, words: "copy path location", run: () => one && c.actions.copyPath(one.path) },
      properties: { label: `Properties of ${what}`, words: "properties info details owner permissions", run: () => one && c.actions.properties(one.path) },
      "used-by": { label: `Apps that use ${what}`, words: "used by apps containers", run: () => one && c.actions.properties(one.path, "apps") },
      ownership: { label: `Fix ownership of ${what} for an app…`, words: "ownership owner chown permissions", run: () => one && c.actions.fixOwnership(one.path) },
      measure: { label: one ? `Measure ${what}` : "Measure folder sizes again", words: "measure size du space", run: () => (one ? void c.actions.measure(one) : here && void c.actions.measure({ path: here.path, name: here.name }, true)) },
      trash: { label: `Move ${what} to the trash`, words: "trash delete remove bin rm", hint: "Del", danger: true, run: () => void c.actions.trash(sel, () => b()?.clear()) },
      paste: { label: "Paste here", words: "paste", hint: `${mod}V`, run: () => here && void c.actions.paste(here.path) },
      "new-folder": { label: "New folder", words: "new folder mkdir create make", hint: newFolderHint(), run: () => b()?.newFolder() },
      "new-file": { label: "New text file", words: "new file text create touch note", run: () => b()?.newFile() },
      upload: { label: "Upload files here", words: "upload add send", run: () => here && c.actions.pickFiles(here.path) },
      "upload-folder": { label: "Upload a whole folder here", words: "upload folder directory", run: () => here && c.actions.pickFiles(here.path, true) },
      up: { label: "Go up a folder", words: "up parent back", hint: "⌫", run: () => here?.parent && c.go(here.parent) },
      "view-columns": { label: "Show as columns", words: "view columns miller", run: () => b()?.setView("columns") },
      "view-list": { label: "Show as a list", words: "view list rows details", run: () => b()?.setView("list") },
      "view-grid": { label: "Show as a grid", words: "view grid tiles thumbnails photos", run: () => b()?.setView("grid") },
      hidden: { label: prefs.filesShowHidden ? "Hide hidden files" : "Show hidden files", words: "hidden dotfiles show hide", run: () => void setPrefs({ filesShowHidden: !prefs.filesShowHidden }) },
      "sort-name": { label: "Sort by name", words: "sort order name", run: () => void setPrefs({ filesSort: "name" }) },
      "sort-mtime": { label: "Sort by date modified", words: "sort order date modified newest", run: () => void setPrefs({ filesSort: "modified" }) },
      "sort-size": { label: "Sort by size", words: "sort order size largest", run: () => void setPrefs({ filesSort: "size" }) },
      "sort-kind": { label: "Sort by kind", words: "sort order kind type", run: () => void setPrefs({ filesSort: "kind" }) },
      "pin-here": { label: here?.self.pinned ? "Unpin this folder" : "Pin this folder", words: "pin favourite this folder", run: () => here && void c.actions.togglePin({ path: here.path, name: here.name, pinned: here.self.pinned }) },
      "path-here": { label: "Copy this folder's path", words: "copy path location", run: () => here && c.actions.copyPath(here.path) },
      "props-here": { label: "This folder's properties", words: "properties info details", run: () => here && c.actions.properties(here.path) },
      "trash-view": { label: "Open the trash", words: "trash bin deleted restore", run: () => window.history.pushState(null, "", "/files?view=trash") },
      keys: { label: "Keyboard shortcuts", words: "keys keyboard shortcuts help", hint: "?", run: c.showKeys },
    };
    const groupOf = (id: CommandId): CmdGroup =>
      id.startsWith("view-") || id === "hidden" ? "View" : id.startsWith("sort-") ? "Sort" : id === "trash-view" || id === "keys" ? "Files" : n && SELECTION_IDS.has(id) ? "Selection" : "This folder";
    return ids.flatMap((id) => (all[id] ? [{ id, group: groupOf(id), icon: (id === "pin" && one?.pinned) || (id === "pin-here" && here?.self.pinned) ? <PinSlash /> : id === "hidden" && prefs.filesShowHidden ? <EyeClosed /> : (ICONS[id] ?? null), ...all[id]! }] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, c.selection.writable, c.selection.dir, here, browsing, c.admin, prefs.filesShowHidden, fmt, held, writable]);

  // ---- searching (debounced, from two letters or a recognised word)
  const roots = React.useMemo(() => collectionRoots(c.places), [c.places]);
  const [spec, setSpec] = React.useState<SearchSpec | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (parsed.mode === "find" && (parsed.name.length >= 2 || parsed.tokens.length)) {
        const filters = parsed.kinds.length > 0 || !!parsed.minSize || !!parsed.days;
        // The server matches the name (and, with a filter, folders on the way), so nothing is cut by a limit first.
        setSpec({ roots: scope ? [scope] : roots, q: parsed.name || "*", inPath: filters && !!parsed.name, kinds: parsed.kinds.length ? parsed.kinds : undefined, modifiedWithinDays: parsed.days ?? undefined, minSize: parsed.minSize ?? undefined, type: filters ? "file" : undefined, limit: 2000 });
      } else if (parsed.mode === "dest" && parsed.text.length >= 2 && sel.length) {
        setSpec({ roots: roots.length ? roots : [c.path ?? "/"], q: parsed.text, type: "dir", depth: 5, limit: 60 });
      } else setSpec(null);
    }, 250);
    return () => clearTimeout(t);
  }, [parsed, scope, roots, c.path, sel.length]);
  const found = useFileSearch(spec);

  // ---- completing a typed path
  const typed = parsed.mode === "path" ? splitTypedPath(parsed.text) : null;
  const completions = useApi<ListingT>(typed ? `/api/files/list?path=${encodeURIComponent(typed.dir)}&only=dirs&limit=400${prefs.filesShowHidden || typed.stem.startsWith(".") ? "&hidden=1" : ""}` : null, { keepPreviousData: true, shouldRetryOnError: false });

  const sections: Section[] = React.useMemo(() => {
    const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
    switch (parsed.mode) {
      case "empty":
        return [];
      case "path": {
        const names = completions.data && completions.data.path === typed!.dir ? completions.data.entries.map((e) => e.name) : [];
        const list = rankCompletions(names, typed!.stem).map((n): Item => ({ key: `f:${n}`, type: "folder", path: joinPath(typed!.dir, n), name: n }));
        const exact = parsed.text.replace(/\/+$/, "") || "/";
        return [
          { title: "Go to", items: [{ key: "go", type: "folder", path: exact, name: exact, exact: true }] },
          { title: `Folders in ${typed!.dir}`, items: list, empty: completions.error ? completions.error.message : completions.data ? "No folders here start with that." : "Looking…" },
        ];
      }
      case "action": {
        const hits = commands.filter((x) => !parsed.text || has(`${x.label} ${x.words}`, parsed.text));
        if (!hits.length) return [{ title: "Actions", items: [], empty: "No action matches. Try a word like rename, move, zip or upload." }];
        return GROUPS.map((g) => ({ title: g === "Selection" ? `${fmt.plural(sel.length, "selected item")}` : g, items: hits.filter((x) => x.group === g).map((x): Item => ({ key: x.id, type: "cmd", cmd: x })) })).filter((x) => x.items.length);
      }
      case "dest": {
        const seen = new Set<string>();
        const dests: Item[] = [];
        const add = (p: string, label: string, detail: string) => {
          if (seen.has(p) || sel.some((e) => e.path === p || (parsed.verb === "move" && parentOf(e.path) === p))) return;
          seen.add(p);
          dests.push({ key: `d:${p}`, type: "dest", path: p, label, detail });
        };
        for (const pl of placeList(c.places)) if (!parsed.text || has(`${pl.label} ${pl.path}`, parsed.text)) add(pl.path, pl.label, pl.path);
        for (const r of here?.entries ?? []) if (isDirLike(r) && (!parsed.text || has(r.name, parsed.text))) add(r.path, r.name, r.path);
        for (const h of found.hits) if (h.type === "dir") add(h.path, h.name, h.path);
        if (!sel.length) return [{ title: parsed.verb === "move" ? "Move to" : "Copy to", items: [], empty: `Select what to ${parsed.verb} first, then type ${parsed.verb} to and part of a folder's name.` }];
        return [{ title: `${parsed.verb === "move" ? "Move" : "Copy"} ${fmt.plural(sel.length, "item")} to`, meta: spec && !found.done ? "Looking…" : undefined, items: dests.slice(0, 60), empty: "Type part of a folder's name." }];
      }
      case "find": {
        const out: Section[] = [];
        if (!parsed.tokens.length) {
          const pls = placeList(c.places)
            .filter((p) => has(p.label, parsed.name) && p.path !== c.path)
            .slice(0, 4);
          if (pls.length) out.push({ title: "Go to", items: pls.map((p): Item => ({ key: `p:${p.path}`, type: "place", place: p })) });
          const cmds = commands.filter((x) => has(`${x.label} ${x.words}`, parsed.name)).slice(0, 3);
          if (cmds.length) out.push({ title: "Do", items: cmds.map((x): Item => ({ key: x.id, type: "cmd", cmd: x })) });
        }
        const now = Date.now();
        const sortBy = prefs.filesSort === "modified" ? "mtime" : prefs.filesSort === "size" ? "size" : "name";
        const order = sortBy === "name" ? "asc" : "desc";
        const filter = { name: parsed.name, kinds: parsed.kinds, days: parsed.days, minSize: parsed.minSize };
        const direct = scope && here ? here.entries.filter((e) => matches(e, filter, now)) : [];
        if (scope && here) out.push({ title: `In ${here.path === "/" ? "Computer" : here.name}`, meta: <span className="num">{direct.length.toLocaleString()}</span>, items: direct.slice(0, 100).map((e): Item => ({ key: e.path, type: "entry", entry: e })), empty: "Nothing in this folder itself." });
        if (spec) {
          const shown = new Set(direct.map((e) => e.path));
          // Everything the server found that isn't already listed above (a big folder's later pages included).
          const deeper = found.hits.filter((h) => !shown.has(h.path));
          out.push({
            title: scope ? "Everywhere inside" : "In every folder",
            meta: <span className="num">{found.done ? `${deeper.length.toLocaleString()}${found.truncated ? "+" : ""}` : `${deeper.length.toLocaleString()} so far`}</span>,
            // Found in disk order; shown the way folders are sorted, once the search has finished.
            items: (found.done ? sortItems(deeper, sortBy, order) : deeper).slice(0, 400).map((h): Item => ({ key: `h:${h.path}`, type: "hit", hit: h })),
            empty: found.done ? "Nothing matches in here." : "Looking through every folder…",
          });
        }
        if (scope && parsed.name.length >= 2) out.push({ title: "Elsewhere", items: [{ key: "everywhere", type: "everywhere", q: text.trim() }] });
        return out;
      }
    }
  }, [parsed, completions.data, completions.error, typed, commands, sel, c.places, here, found, spec, scope, c.path, fmt, browsing, text, prefs.filesSort]);

  const flat = React.useMemo(() => sections.flatMap((x) => x.items), [sections]);

  const run = (it: Item, how: "open" | "look" = "open") => {
    const close = () => setText("");
    const reveal = (p: string, name: string) => {
      close();
      c.go(parentOf(p), { select: name });
    };
    switch (it.type) {
      case "entry":
        if (how === "look" && !isDirLike(it.entry)) return c.look(it.entry, c.here?.entries ?? []);
        if (isDirLike(it.entry)) return close(), c.go(it.entry.path);
        return reveal(it.entry.path, it.entry.name);
      case "hit":
        if (it.hit.type === "dir") return close(), c.go(it.hit.path);
        if (how === "look") return c.lookHit(it.hit, found.hits);
        return reveal(it.hit.path, it.hit.name);
      case "place":
        return close(), c.go(it.place.path);
      case "folder":
        return close(), c.go(it.path);
      case "cmd":
        if (it.cmd.next) return setText(it.cmd.next);
        close();
        return it.cmd.run();
      case "dest": {
        const verb = parsed.mode === "dest" ? parsed.verb : "move";
        close();
        void c.actions.transfer(sel.map((e) => e.path), it.path, verb).then((ok) => ok && c.browser.current?.clear());
        return;
      }
      case "everywhere":
        return setEverywhere(true);
    }
  };

  const focus = React.useCallback(
    (prefill?: string) => {
      if (prefill !== undefined) setText(prefill);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [setText],
  );

  // ---- keys anywhere on Files: ⌘F finds, ⌘L types a path, > lists actions, ? shows the keys
  const keysRef = React.useRef({ here, focus, showKeys: c.showKeys });
  keysRef.current = { here, focus, showKeys: c.showKeys };
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable],[role=dialog],[role=menu],[role=alertdialog]")) return;
      const m = e.metaKey || e.ctrlKey;
      const k = keysRef.current;
      if (m && !e.shiftKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "l")) {
        e.preventDefault();
        k.focus(e.key.toLowerCase() === "l" ? `${k.here && k.here.path !== "/" ? k.here.path : ""}/` : undefined);
      } else if (!m && !e.altKey && e.key === ">") {
        e.preventDefault();
        k.focus(">");
      } else if (!m && !e.altKey && e.key === "?") {
        e.preventDefault();
        k.showKeys();
      }
    };
    // "/" inside a folder starts a path (the shell would open its palette); capture runs first.
    const onSlash = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || !t?.closest("[data-files-keys]")) return;
      e.preventDefault();
      e.stopPropagation();
      keysRef.current.focus(`${keysRef.current.here && keysRef.current.here.path !== "/" ? keysRef.current.here.path : ""}/`);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onSlash, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSlash, true);
    };
  }, []);

  return {
    text,
    setText,
    parsed,
    active: parsed.mode !== "empty" && open,
    setOpen,
    everywhere,
    setEverywhere,
    inputRef,
    focus,
    sections,
    flat,
    index: Math.min(index, Math.max(0, flat.length - 1)),
    setIndex,
    run,
    found,
    searching: !!spec && !found.done,
    scope: scope ?? "",
  };
}

// ---------------------------------------------------------------- the bar

export function CommandBar() {
  const f = useFiles();
  const { here, selection } = useBarState();
  const c = useCommand({ screen: f.screen, path: f.path, here, selection, places: f.places, actions: f.actions, go: f.go, browser: f.browser, admin: f.admin, showKeys: f.showKeys, look: f.look, lookHit: f.lookHit });
  const fmt = useFormat();
  const list = React.useRef<HTMLDivElement>(null);
  const n = selection.entries.length;
  const scopeName = c.scope ? (c.scope === "/" ? "Computer" : baseName(c.scope)) : f.screen === "trash" ? "Files" : "Every folder";
  const narrow = useMediaQuery("(max-width: 720px)");
  const mod = useModKey();
  const what = n === 1 ? selection.entries[0]!.name : fmt.plural(n, "item");
  const placeholder = narrow
    ? n
      ? `Act on ${fmt.plural(n, "item")}`
      : f.screen === "browse"
        ? "Search this folder"
        : "Search everything"
    : n
      ? `Type > to act on ${what}, or move to …`
      : f.screen === "browse"
        ? "Find in this folder, type a path, or > for actions"
        : "Search every folder: a name, *.mkv, photos this week…";
  const wrap = React.useRef<HTMLDivElement>(null);
  // A click anywhere else puts the results away; what was typed stays for when you come back.
  React.useEffect(() => {
    if (!c.active) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) c.setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [c]);

  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    const fromList = e.currentTarget !== c.inputRef.current;
    if (e.key === "ArrowDown" && c.active) {
      e.preventDefault();
      c.setIndex(Math.min(c.flat.length - 1, c.index + 1));
    } else if (e.key === "ArrowUp" && c.active) {
      e.preventDefault();
      c.setIndex(Math.max(0, c.index - 1));
    } else if (e.key === "ArrowDown" && !c.active) {
      e.preventDefault();
      document.querySelector<HTMLElement>("[data-files-keys][tabindex='0']")?.focus();
    } else if (e.key === "Enter" && c.active) {
      e.preventDefault();
      const it = c.flat[c.index];
      if (it) c.run(it, e.metaKey || e.ctrlKey ? "look" : "open");
    } else if (e.key === " " && fromList) {
      e.preventDefault();
      const it = c.flat[c.index];
      if (it) c.run(it, "look");
    } else if (e.key === "Tab" && !e.shiftKey && c.parsed.mode === "path" && c.flat[c.index]?.type === "folder" && !fromList) {
      e.preventDefault();
      const it = c.flat[c.index] as Extract<Item, { type: "folder" }>;
      c.setText(`${it.path === "/" ? "" : it.path}/`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (c.text) {
        c.setText("");
        c.setOpen(false);
        c.inputRef.current?.focus();
      } else c.inputRef.current?.blur();
    } else if (e.key === "Backspace" && !c.text && !fromList && here?.parent && f.screen === "browse") {
      e.preventDefault();
      f.go(here.parent);
    }
  };

  React.useEffect(() => {
    list.current?.querySelector(`#cmd-opt-${c.index}`)?.scrollIntoView({ block: "nearest" });
  }, [c.index]);

  return (
    <div ref={wrap} className={s.wrap} data-active={c.active ? "" : undefined}>
      <div className={s.line}>
        <span className={s.scope} title={c.scope || undefined}>
          {c.everywhere && f.screen === "browse" ? (
            <button type="button" className={s.scopeBtn} onClick={() => c.setEverywhere(false)} aria-label="Search only this folder again">
              Every folder <Xmark aria-hidden />
            </button>
          ) : (
            scopeName
          )}
        </span>
        <Search className={s.icon} aria-hidden />
        <input
          ref={c.inputRef}
          className={s.input}
          value={c.text}
          onChange={(e) => c.setText(e.target.value)}
          onFocus={() => c.text && c.setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label="Find files, go to a path, or run an action"
          role="combobox"
          aria-expanded={c.active}
          aria-controls="files-command-results"
          aria-activedescendant={c.active && c.flat.length ? `cmd-opt-${c.index}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="go"
        />
        {c.text ? (
          <IconButton label="Clear" size="sm" onClick={() => c.setText("")}>
            <Xmark />
          </IconButton>
        ) : (
          !narrow && (
            <kbd className={s.kbd} aria-hidden>
              {mod}F
            </kbd>
          )
        )}
      </div>
      {f.screen === "front" && (
        <div className={s.quick} role="group" aria-label="Quick filters">
          {QUICK.map((q) => {
            const on = hasWord(c.text, q.word);
            return (
              <button key={q.word} type="button" className={s.chip} aria-pressed={on} onClick={() => c.setText(toggleWord(c.text, q.word))}>
                {on && <Check aria-hidden />}
                {q.label}
              </button>
            );
          })}
        </div>
      )}
      {c.active && (
        <div ref={list} className={s.panel} id="files-command-results" role="listbox" aria-label="Results" tabIndex={-1} onKeyDown={onKey}>
          {c.parsed.mode === "find" && c.parsed.tokens.length > 0 && (
            <p className={s.understood}>
              Looking for {c.parsed.tokens.map((t) => (t.type === "size" ? `over ${fmt.bytes(t.bytes)}` : t.label.toLowerCase())).join(", ")}
              {c.parsed.name && <> with “{c.parsed.name}” in the name or a folder on the way</>}, in {c.scope ? `${scopeName} and every folder inside it` : "every folder you can open"}.
            </p>
          )}
          {c.found.error && <Notice tone="fault" title="The search stopped">{c.found.error}</Notice>}
          {c.found.timedOut && <Notice tone="attention">The search took longer than 30 seconds and stopped early. Search inside a smaller folder to see everything.</Notice>}
          <Sections c={c} />
        </div>
      )}
      <p className={s.hints} aria-hidden>
        {c.active ? (
          <>
            <kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>↵</kbd> open · <kbd>{mod}↵</kbd> quick look{c.parsed.mode === "path" && <> · <kbd>Tab</kbd> completes</>} · <kbd>Esc</kbd> back
          </>
        ) : (
          <>
            Type to find · <kbd>/</kbd> a path · <kbd>&gt;</kbd> actions · <kbd>Space</kbd> quick look · <kbd>?</kbd> all keys
          </>
        )}
      </p>
    </div>
  );
}

function Sections({ c }: { c: CommandState }) {
  const fmt = useFormat();
  let i = -1;
  const anything = c.flat.length > 0;
  const q = c.parsed.mode === "find" ? c.parsed.name : c.parsed.mode === "dest" ? c.parsed.text : "";
  return (
    <>
      {c.sections
        .filter((sec) => sec.items.length || !anything || sec.title === "Everywhere inside" || sec.title === "In every folder")
        .map((sec) => (
          <section key={sec.title} className={s.section} aria-label={sec.title}>
            <div className={s.sectionHead}>
              <span className="label">{sec.title}</span>
              {sec.meta && <span className={s.sectionMeta}>{sec.meta}</span>}
            </div>
            {!sec.items.length ? (
              <p className={s.none}>{sec.empty ?? "Nothing matches."}</p>
            ) : (
              sec.items.map((it) => {
                i++;
                const idx = i;
                return (
                  <div
                    key={it.key}
                    id={`cmd-opt-${idx}`}
                    role="option"
                    aria-selected={c.index === idx}
                    className={s.option}
                    data-active={c.index === idx ? "" : undefined}
                    data-danger={it.type === "cmd" && it.cmd.danger ? "" : undefined}
                    onMouseMove={() => c.index !== idx && c.setIndex(idx)}
                    onClick={() => c.run(it)}
                  >
                    <Option it={it} q={q} fmt={fmt} onLook={() => c.run(it, "look")} />
                  </div>
                );
              })
            )}
          </section>
        ))}
      {!anything && !c.searching && c.parsed.mode === "find" && <p className={s.none}>Try part of the name, a word like “photos” or “this week”, or * as a wildcard (for example *.mkv).</p>}
    </>
  );
}

function Mark({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={s.mark}>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Option({ it, q, fmt, onLook }: { it: Item; q: string; fmt: ReturnType<typeof useFormat>; onLook: () => void }) {
  switch (it.type) {
    case "entry":
    case "hit": {
      const e = it.type === "entry" ? it.entry : it.hit;
      const dir = e.kind === "folder";
      return (
        <>
          <span className={s.optFace}>
            <Thumb item={e} size={160} />
          </span>
          <span className={s.optText}>
            <span className="truncate">
              <Mark text={e.name} q={q} />
            </span>
            {it.type === "hit" && <span className={`${s.optSub} mono truncate`}>{parentOf(it.hit.path)}</span>}
          </span>
          <span className={`${s.optMeta} num`}>
            {!dir && e.size !== null && fmt.bytes(e.size)} <FileTime ts={e.mtime} />
          </span>
          {!dir && (
            <button
              type="button"
              className={s.look}
              aria-label={`Quick look at ${e.name}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onLook();
              }}
            >
              <Eye />
            </button>
          )}
        </>
      );
    }
    case "place":
      return (
        <>
          <span className={s.optFace} data-glyph="">
            <PlaceIcon kind={it.place.kind} />
          </span>
          <span className={s.optText}>
            <span className="truncate">
              <Mark text={it.place.label} q={q} />
            </span>
            <span className={`${s.optSub} mono truncate`}>{it.place.path}</span>
          </span>
          <NavArrowRight className={s.optArrow} aria-hidden />
        </>
      );
    case "folder":
      return (
        <>
          <span className={s.optFace} data-glyph="">
            <KindIcon kind="folder" />
          </span>
          <span className={`${s.optText} mono`}>
            <span className="truncate">{it.exact ? `Open ${it.name}` : it.name}</span>
          </span>
          {!it.exact && <span className={s.optMeta}>Tab</span>}
        </>
      );
    case "dest":
      return (
        <>
          <span className={s.optFace} data-glyph="">
            <KindIcon kind="folder" />
          </span>
          <span className={s.optText}>
            <span className="truncate">
              <Mark text={it.label} q={q} />
            </span>
            <span className={`${s.optSub} mono truncate`}>{it.detail}</span>
          </span>
          <span className={s.optMeta}>↵</span>
        </>
      );
    case "cmd":
      return (
        <>
          <span className={s.optIcon} aria-hidden>
            {it.cmd.icon}
          </span>
          <span className={s.optText}>
            <span className="truncate">{it.cmd.label}</span>
          </span>
          {it.cmd.hint && <span className={`${s.optMeta} mono`}>{it.cmd.hint}</span>}
        </>
      );
    case "everywhere":
      return (
        <>
          <span className={s.optFace} data-glyph="">
            <Search />
          </span>
          <span className={s.optText}>
            <span className="truncate">Search every folder for “{it.q}”</span>
          </span>
        </>
      );
  }
}

