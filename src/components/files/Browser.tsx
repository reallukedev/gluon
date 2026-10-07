"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { mutate as globalMutate } from "swr";
import { Check, Copy, DataTransferBoth, Download, Drag, EditPencil, Eye, EyeClosed, FolderPlus, List, MoreHoriz, NavArrowLeft, NavArrowRight, PasteClipboard, PinSlash, Trash, Upload, ViewColumns3, ViewGrid, Folder, Xmark } from "iconoir-react";
import type { FileEntry, Listing as ListingT, Place, SortKey } from "@/lib/files-types";
import { api, type ApiError } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Segmented } from "@/components/ui/Field";
import { ContextMenu, Menu, type MenuEntry } from "@/components/ui/Menu";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { DiskGlyph } from "@/components/storage/DiskGlyph";
import { UsedBy } from "./Properties";
import { useListing } from "./useListing";
import { readDrop } from "./drop";
import { clip, useClip } from "./clip";
import { entryMenu } from "./actions";
import { readViews, sizeOf, useFolderSizes, useSelectionSize, writeViews } from "./hooks";
import { columnsFor, fullness, groupPlaces, rangeOf, rememberView, viewFor, type FolderView, type PlaceGroup } from "./logic";
import { useFiles } from "./Files";
import { FileTime } from "./FileTime";
import { Facts, PreviewBody, RenameField, SizeRule } from "./PreviewBody";
import { Thumb } from "./Thumb";
import { DRAG_MIME, KindIcon, PlaceIcon, THUMBABLE, baseName, isDirLike, isNewFolderKey, modKey, newFolderHint, parentOf, sortFromPref, thumbUrl, useDropTarget, useMediaQuery } from "./lib";
import s from "./browser.module.css";

// Browsing: the path drawn as columns (each folder beside the one it's in, the file you're on in
// full at the end), or the deepest folder as a list or a grid of pictures. Arrow keys walk the
// tree, dragging between columns moves, and a status line under it all acts on the selection.

export interface BrowserApi {
  rename: (path: string) => void;
  newFolder: () => void;
  newFile: () => void;
  setView: (v: FolderView) => void;
  clear: () => void;
}

interface Sel {
  col: number;
  paths: Set<string>;
  focus: number;
  anchor: number;
}
type Pick = { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

const ROW = 34;
const ROW_TOUCH = 48;
const LIST_ROW = 44;
const TILE_MIN = 156;
const TILE_GAP = 12;
const LONG_PRESS = 450;
const NO_SEL: Sel = { col: 0, paths: new Set(), focus: -1, anchor: -1 };

export const Browser = React.memo(function Browser() {
  const f = useFiles();
  const fmt = useFormat();
  const { prefs, setPrefs } = usePrefs();
  const path = f.path!;
  const phone = useMediaQuery("(max-width: 720px)");
  const touch = useMediaQuery("(hover: none) and (pointer: coarse)");
  const order = sortFromPref(prefs.filesSort);
  const folders = React.useMemo(() => columnsFor(path, f.places, f.admin), [path, f.places, f.admin]);
  const deepest = folders[folders.length - 1]!;
  const last = folders.length - 1;

  const rowsRef = React.useRef(new Map<string, (FileEntry | undefined)[]>());
  const errors = React.useRef(new Map<string, string>());
  const loaders = React.useRef(new Map<string, () => Promise<FileEntry[]>>());
  /** Every item in a column's folder (up to 20,000): a big folder only loads what's on screen. */
  const allIn = async (col: number): Promise<FileEntry[]> => {
    const rows = rowsOf(col);
    // The rows array is sparse (holes for pages not loaded), so count rather than use every().
    if (rows.filter(Boolean).length === rows.length) return rows as FileEntry[];
    const load = loaders.current.get(folders[col] ?? "");
    return load ? load() : rows.filter((r): r is FileEntry => !!r);
  };
  const listings = React.useRef(new Map<string, ListingT>());
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [sel, setSel] = React.useState<Sel>({ ...NO_SEL, col: last });
  const [renaming, setRenaming] = React.useState<{ path: string; draft?: string } | null>(null);
  const [onPlaces, setOnPlaces] = React.useState(false);
  const [phonePreview, setPhonePreview] = React.useState(false);
  const wantFirst = React.useRef<number | null>(null);
  const strip = React.useRef<HTMLDivElement>(null);
  const colRefs = React.useRef(new Map<number, HTMLDivElement>());
  const clipboard = useClip();

  // How the deepest folder is shown: remembered per folder, photo folders as a grid.
  const [views, setViews] = React.useState<Record<string, FolderView>>({});
  React.useEffect(() => setViews(readViews()), []);
  const deepListing = listings.current.get(deepest);
  const view: FolderView = viewFor(views[deepest], (deepListing?.entries ?? []).filter((e) => !isDirLike(e)));
  const setView = React.useCallback(
    (v: FolderView) => {
      setViews((cur) => {
        const next = rememberView(cur, deepest, v);
        writeViews(next);
        return next;
      });
    },
    [deepest],
  );
  const single = view !== "columns";
  const shownFrom = single ? last : 0;

  const rowsOf = React.useCallback((col: number) => rowsRef.current.get(folders[col] ?? "") ?? [], [folders]);
  const entriesIn = (col: number, paths: Set<string>) => rowsOf(col).filter((r): r is FileEntry => !!r && paths.has(r.path));
  const writableAt = (col: number) => {
    const l = listings.current.get(folders[col] ?? "");
    return !!l && l.access === "write" && !l.protectedReason;
  };
  const selected = entriesIn(sel.col, sel.paths);
  const one = selected.length === 1 ? selected[0]! : null;
  const fileOpen = one && !isDirLike(one) ? one : null;

  // Arriving somewhere new: the deepest column has the keyboard.
  const lastPath = React.useRef(path);
  React.useEffect(() => {
    if (lastPath.current === path) return;
    const wasInside = lastPath.current.startsWith(`${path}/`);
    const came = wasInside ? `${path === "/" ? "" : path}/${lastPath.current.slice(path === "/" ? 1 : path.length + 1).split("/")[0]}` : null;
    lastPath.current = path;
    // Opening a folder from its column keeps it selected there; arriving any other way starts fresh.
    setSel((cur) => (folders[cur.col + 1] === path && cur.paths.has(path) ? cur : { ...NO_SEL, col: folders.length - 1 }));
    // Going up lands on the folder you came from.
    if (came) {
      revealRef.current = came;
      tryReveal(path);
    }
    setRenaming(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A list or grid shows only the deepest folder, so that's where the selection lives.
  React.useEffect(() => {
    if (single && sel.col !== last) setSel({ ...NO_SEL, col: last });
  }, [single, sel.col, last]);

  // Tell the rest of Files where we are and what's selected.
  React.useEffect(() => {
    f.setHere(deepListing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepListing]);
  const selKey = [...sel.paths].join("\n");
  React.useEffect(() => {
    f.setSelection({ entries: selected, dir: folders[sel.col] ?? null, writable: writableAt(sel.col) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, sel.col, folders.join("\n")]);

  React.useEffect(() => {
    const el = strip.current;
    if (el && !single) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [folders.length, !!fileOpen, single]);

  const focusCol = (col: number) => requestAnimationFrame(() => colRefs.current.get(col)?.focus({ preventScroll: true }));

  /** Choose an item. In columns a folder opens beside it; in a list or grid it's only selected. */
  const choose = (col: number, i: number, ev: Pick = {}, navigate = true) => {
    const rows = rowsOf(col);
    const e = rows[i];
    if (!e) return;
    setOnPlaces(false);
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      const base = sel.col === col ? sel.paths : new Set<string>();
      if (ev.shiftKey) {
        const anchor = sel.col === col && sel.anchor >= 0 ? sel.anchor : i;
        const keep = ev.metaKey || ev.ctrlKey ? base : new Set<string>();
        const pick = (list: (FileEntry | undefined)[]) => {
          const next = new Set(keep);
          for (const k of rangeOf(anchor, i)) if (list[k]) next.add(list[k]!.path);
          setSel({ col, paths: next, focus: i, anchor });
        };
        // A range can run over rows that haven't loaded yet in a big folder: load them first.
        if (rangeOf(anchor, i).some((k) => !rows[k])) void allIn(col).then(pick);
        else pick(rows);
      } else {
        const next = new Set(base);
        if (next.has(e.path)) next.delete(e.path);
        else next.add(e.path);
        setSel({ col, paths: next, focus: i, anchor: i });
      }
      if (folders[col] !== deepest) f.go(folders[col]!, { replace: true });
      return;
    }
    setSel({ col, paths: new Set([e.path]), focus: i, anchor: i });
    if (!navigate) return;
    if (isDirLike(e) && !e.link?.broken && !e.link?.outside) f.go(e.path, { replace: true });
    else if (folders[col] !== deepest) f.go(folders[col]!, { replace: true });
    if (phone && !isDirLike(e)) setPhonePreview(true);
  };

  const toggle = (col: number, i: number) => {
    const e = rowsOf(col)[i];
    if (!e) return;
    const next = new Set(sel.col === col ? sel.paths : []);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    setSel({ col, paths: next, focus: i, anchor: i });
  };

  const open = (e: FileEntry, col: number) => {
    if (isDirLike(e)) {
      if (e.link?.broken) return toast.error(`${e.name} is a broken link`, { description: `It points to ${e.link.target}, which doesn't exist.` });
      if (e.link?.outside) return toast.error(`${e.name} points outside your shared folders`);
      f.go(e.path);
      wantFirst.current = single ? null : col + 1;
      if (!single) focusCol(col + 1);
      return;
    }
    if (e.link?.broken) return toast.error(`${e.name} is a broken link`, { description: `It points to ${e.link.target}, which doesn't exist.` });
    f.look(e, rowsOf(col).filter((r): r is FileEntry => !!r && !isDirLike(r)));
  };

  const back = (col: number) => {
    if (single || col === shownFrom) {
      if (phone && col === 0 && !single) return setOnPlaces(true);
      const parent = listings.current.get(folders[col]!)?.parent;
      if (parent) f.go(parent);
      return;
    }
    const child = folders[col]!;
    const i = rowsOf(col - 1).findIndex((r) => r?.path === child);
    f.go(child, { replace: true });
    setSel({ col: col - 1, paths: new Set([child]), focus: i, anchor: i });
    setPhonePreview(false);
    focusCol(col - 1);
  };

  async function newFolder() {
    const l = listings.current.get(deepest);
    if (!l) return;
    const made = await f.actions.newFolder(l.path, rowsOf(last).filter((r): r is FileEntry => !!r).map((r) => r.name));
    if (made) {
      revealRef.current = made.path;
      setRenaming({ path: made.path });
    }
  }
  async function newFile() {
    const l = listings.current.get(deepest);
    if (!l) return;
    const made = await f.actions.newTextFile(l.path, rowsOf(last).filter((r): r is FileEntry => !!r).map((r) => r.name));
    if (made) {
      revealRef.current = made.path;
      setRenaming({ path: made.path });
    }
  }
  async function commitRename(e: FileEntry, name: string) {
    setRenaming(null);
    focusCol(sel.col);
    const r = await f.actions.rename(e, name);
    if (r) {
      revealRef.current = r.path;
      if (clip.get()?.paths.includes(e.path)) clip.set(null);
    }
    // Back into the field with what they typed, so they can fix it rather than start again.
    else setRenaming({ path: e.path, draft: name });
  }

  const clear = () => setSel((c) => ({ ...c, paths: new Set() }));
  /** Everything in the folder, not just the rows that have loaded (up to 20,000). */
  const selectAll = (col: number) => {
    const dir = folders[col]!;
    void allIn(col).then((all) => {
      setSel((cur) => ({ col, paths: new Set(all.map((r) => r.path)), focus: cur.col === col ? cur.focus : 0, anchor: cur.col === col ? cur.anchor : 0 }));
      if ((listings.current.get(dir)?.total ?? 0) > all.length) toast.info(`Selected the first ${all.length.toLocaleString()} items`);
    });
    if (dir !== deepest) f.go(dir, { replace: true });
  };
  React.useImperativeHandle(f.browser, () => ({ rename: (p) => setRenaming({ path: p }), newFolder: () => void newFolder(), newFile: () => void newFile(), setView, clear }));

  // ---- refreshes: every visible column listens
  const refreshers = React.useRef(new Map<string, () => void>());
  React.useEffect(() => f.onRefresh(() => refreshers.current.forEach((r) => r())), [f.onRefresh]);
  useFolderSizes(deepListing && !deepListing.sortLimited ? deepListing : undefined, () => refreshers.current.get(deepest)?.());

  // Landing on a named item: ?select=, a search result, a new folder, or the folder you came up from.
  const revealRef = React.useRef<string | null>(null);
  const ensures = React.useRef(new Map<string, (i: number) => void>());
  const tryReveal = (folder: string) => {
    const want = revealRef.current;
    const rows = rowsRef.current.get(folder);
    const listing = listings.current.get(folder);
    if (!want || parentOf(want) !== folder || !rows || !listing) return;
    const col = folders.indexOf(folder);
    const i = rows.findIndex((r) => r?.path === want);
    if (i >= 0) {
      revealRef.current = null;
      f.doneReveal();
      setSel({ col, paths: new Set([want]), focus: i, anchor: i });
      focusCol(col);
    } else if (rows.filter(Boolean).length < listing.total) {
      // Not loaded yet in a big folder: load the rest (up to 20,000) and look again.
      const ensure = ensures.current.get(folder);
      for (let k = 0; ensure && k < Math.min(listing.total, 20_000); k += 500) ensure(k);
    } else {
      revealRef.current = null;
      f.doneReveal();
      toast.info(`${baseName(want)} isn't in this folder any more`);
    }
  };
  React.useEffect(() => {
    if (!f.reveal) return;
    revealRef.current = f.reveal;
    tryReveal(parentOf(f.reveal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.reveal]);

  const onRows = React.useCallback(
    (folder: string, rows: (FileEntry | undefined)[], listing: ListingT | undefined, refresh: () => void, ensure: (i: number) => void, error: ApiError | null, loadAll: () => Promise<FileEntry[]>) => {
      loaders.current.set(folder, loadAll);
      if (error && errors.current.get(folder) !== error.code) {
        errors.current.set(folder, error.code);
        // A file's path opens the folder it's in, with the file selected.
        if (error.code === "not_a_folder" && folder === folders[folders.length - 1]) f.go(parentOf(folder), { select: baseName(folder), replace: true });
      } else if (!error) errors.current.delete(folder);
      if (folder === folders[folders.length - 1] || error) f.setHereError(error);
      rowsRef.current.set(folder, rows);
      if (listing) listings.current.set(folder, listing);
      refreshers.current.set(folder, refresh);
      const col = folders.indexOf(folder);
      if (col >= 0 && wantFirst.current === col && rows[0]) {
        wantFirst.current = null;
        setSel({ col, paths: new Set([rows[0].path]), focus: 0, anchor: 0 });
      }
      ensures.current.set(folder, ensure);
      if (listing) tryReveal(folder);
      bump();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders.join("\n")],
  );

  // ---- keys inside a column or the list/grid
  const typed = React.useRef({ text: "", at: 0 });
  const onKeys = (col: number, ev: React.KeyboardEvent, grid: { cols: number } | null) => {
    if (renaming || (ev.target as HTMLElement).closest("input,button,[role=menuitem]")) return;
    const rows = rowsOf(col);
    const m = ev.metaKey || ev.ctrlKey;
    const cur = sel.col === col ? sel.focus : -1;
    const curEntry = rows[cur];
    const inPane = single;
    const step = (to: number) => {
      const i = Math.max(0, Math.min(rows.length - 1, to));
      choose(col, i, ev.shiftKey ? { shiftKey: true } : {}, !inPane);
    };
    const targets = () => entriesIn(col, sel.col === col ? sel.paths : new Set());
    const w = writableAt(col);
    switch (ev.key) {
      case "ArrowDown":
        if (m && curEntry) open(curEntry, col);
        else step(cur + (grid?.cols ?? 1));
        break;
      case "ArrowUp":
        if (m || ev.altKey) back(col);
        else step(Math.max(0, cur - (grid?.cols ?? 1)));
        break;
      case "ArrowRight":
        if (grid) step(cur + 1);
        else if (!inPane && curEntry && isDirLike(curEntry)) open(curEntry, col);
        else return;
        break;
      case "ArrowLeft":
        if (grid) step(cur - 1);
        else if (!inPane) back(col);
        else return;
        break;
      case "Home":
        step(0);
        break;
      case "End":
        step(rows.length - 1);
        break;
      case "PageDown":
      case "PageUp": {
        const page = Math.max(1, Math.floor(((ev.currentTarget as HTMLElement).clientHeight || 400) / (grid ? 200 : ROW)) - 1) * (grid?.cols ?? 1);
        step(cur + (ev.key === "PageDown" ? page : -page));
        break;
      }
      case "Enter":
        if (curEntry) open(curEntry, col);
        break;
      case " ":
        if (curEntry && !isDirLike(curEntry)) f.look(curEntry, rows.filter((r): r is FileEntry => !!r && !isDirLike(r)));
        else if (curEntry) toggle(col, cur);
        break;
      case "Backspace":
        if (m && w && targets().length) void f.actions.trash(targets(), clear);
        else back(col);
        break;
      case "Delete":
        if (w && targets().length) void f.actions.trash(targets(), clear);
        break;
      case "F2":
        if (w && curEntry) setRenaming({ path: curEntry.path });
        break;
      case "Escape":
        if (!sel.paths.size) return;
        clear();
        break;
      default: {
        if (m && !ev.altKey && !ev.shiftKey) {
          const k = ev.key.toLowerCase();
          const dir = folders[col]!;
          if (k === "a") {
            selectAll(col);
          } else if (k === "c" && targets().length) f.actions.toClipboard("copy", targets(), dir);
          else if (k === "x" && targets().length && w) f.actions.toClipboard("cut", targets(), dir);
          else if (k === "v" && w) void f.actions.paste(dir);
          else if (k === "d" && targets().length && w) void f.actions.transfer(targets().map((t) => t.path), dir, "copy");
          else return;
          break;
        }
        // Type the start of a name to jump to it.
        if (m || ev.altKey || ev.key.length !== 1) return;
        const t = typed.current;
        const now = Date.now();
        t.text = now - t.at > 800 ? ev.key.toLowerCase() : t.text + ev.key.toLowerCase();
        t.at = now;
        const from = t.text.length === 1 ? cur + 1 : Math.max(cur, 0);
        let hit = -1;
        for (let k = 0; k < rows.length && hit < 0; k++) {
          const i = (from + k) % rows.length;
          if (rows[i]?.name.toLowerCase().startsWith(t.text)) hit = i;
        }
        if (hit < 0) return;
        choose(col, hit, {}, !inPane);
      }
    }
    ev.preventDefault();
  };

  // ⌥⌘N (Ctrl+Alt+N) anywhere in a folder makes a new folder.
  const newFolderRef = React.useRef(newFolder);
  newFolderRef.current = newFolder;
  const deepWritable = writableAt(last);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isNewFolderKey(e)) return;
      if ((e.target as HTMLElement)?.closest("input,textarea,[role=dialog]")) return;
      e.preventDefault();
      if (deepWritable) void newFolderRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deepWritable]);

  // ---- files from the computer: dropped on a folder they upload into it
  const [dropping, setDropping] = React.useState<{ into: string; ok: boolean } | null>(null);
  const depth = React.useRef(0);
  const dropAt = (e: React.DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-dir-path]");
    const colEl = (e.target as HTMLElement).closest<HTMLElement>("[data-col-path]");
    const into = row?.dataset.dirPath ?? colEl?.dataset.colPath ?? deepest;
    const l = listings.current.get(colEl?.dataset.colPath ?? deepest);
    return { into, ok: !!l && l.access === "write" && !l.protectedReason };
  };
  const osDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      depth.current++;
      setDropping(dropAt(e));
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      const d = dropAt(e);
      e.dataTransfer.dropEffect = d.ok ? "copy" : "none";
      if (d.into !== dropping?.into) setDropping(d);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDropping(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      depth.current = 0;
      const d = dropAt(e);
      setDropping(null);
      if (!d.ok) return toast.error("You can't upload into this folder", { description: listings.current.get(deepest)?.protectedReason ?? undefined });
      void readDrop(e.dataTransfer).then((r) => f.actions.upload(r, d.into), (err) => toast.error("Couldn't read what you dropped", { description: err instanceof Error ? err.message : undefined }));
    },
  };

  const menuFor = (col: number, entries: FileEntry[]): MenuEntry[] =>
    entryMenu(entries, { actions: f.actions, writable: writableAt(col), dir: folders[col]!, onOpen: (e) => open(e, col), onRename: (e) => setRenaming({ path: e.path }), after: clear });
  const backgroundMenu = (col: number): MenuEntry[] => {
    const w = writableAt(col);
    const l = listings.current.get(folders[col]!);
    const held = clip.get();
    return [
      ...(w
        ? ([
            { label: "New folder", icon: <FolderPlus />, hint: newFolderHint(), onSelect: () => void newFolder() },
            { label: "New text file", onSelect: () => void newFile() },
            { label: held ? `Paste ${held.paths.length === 1 ? held.first : fmt.plural(held.paths.length, "item")}` : "Paste", icon: <PasteClipboard />, hint: `${modKey()}V`, disabled: !held, onSelect: () => void f.actions.paste(folders[col]!) },
            "separator",
            { label: "Upload files…", icon: <Upload />, onSelect: () => f.actions.pickFiles(folders[col]!) },
            { label: "Upload a folder…", icon: <Upload />, onSelect: () => f.actions.pickFiles(folders[col]!, true) },
            "separator",
          ] as MenuEntry[])
        : []),
      { label: "Select all", hint: `${modKey()}A`, onSelect: () => selectAll(col) },
      { kind: "check", label: "Show hidden files", checked: prefs.filesShowHidden, onChange: (v) => void setPrefs({ filesShowHidden: v }) },
      ...(l ? ([{ label: "Measure folder sizes again", onSelect: () => void f.actions.measure({ path: l.path, name: l.name }, true) }, { label: "Properties", onSelect: () => f.actions.properties(l.path) }] as MenuEntry[]) : []),
    ];
  };

  // Rows are memoised; they get the same callbacks every render, which read the latest state here.
  const live = React.useRef({ choose, toggle, open, onKeys, commitRename, menuFor, backgroundMenu, rowsOf, single, sel });
  live.current = { choose, toggle, open, onKeys, commitRename, menuFor, backgroundMenu, rowsOf, single, sel };
  const handlerCache = React.useRef(new Map<number, ColumnHandlers>());
  const handlersFor = (col: number): ColumnHandlers => {
    let h = handlerCache.current.get(col);
    if (!h) {
      const L = () => live.current;
      h = {
        onChoose: (i, ev) => L().choose(col, i, ev, !L().single),
        onToggle: (i) => L().toggle(col, i),
        onOpen: (i) => {
          const e = L().rowsOf(col)[i];
          if (e) L().open(e, col);
        },
        onKey: (ev, grid) => L().onKeys(col, ev, grid),
        onRenameCommit: (e, n) => void L().commitRename(e, n),
        // The field goes away; give the keyboard back to the column so arrows keep working.
        onRenameCancel: () => {
          setRenaming(null);
          focusCol(col);
        },
        menuFor: (es) => L().menuFor(col, es),
        backgroundMenu: () => L().backgroundMenu(col),
        onDropItems: (src, dest, copy) => void f.actions.transfer(src, dest, copy ? "copy" : "move"),
        dragFrom: (path) => {
          const s0 = L().sel;
          return s0.col === col && s0.paths.has(path) ? [...s0.paths] : [path];
        },
        refCb: (el) => {
          if (el) colRefs.current.set(col, el);
          else colRefs.current.delete(col);
        },
      };
      handlerCache.current.set(col, h);
    }
    return h;
  };
  const cutPaths = React.useMemo(() => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : null), [clipboard]);

  const selSize = useSelectionSize(selected);
  // Columns stop at the first folder that can't be listed; the ones below it can't be either.
  const brokenAt = folders.findIndex((p) => errors.current.has(p));
  const firstBroken = brokenAt >= 0 ? brokenAt : folders.length - 1;
  const showPreview = !!fileOpen && view !== "grid" && (!phone || phonePreview);
  const current = phone ? (onPlaces ? -1 : phonePreview && fileOpen ? folders.length : sel.col) : null;

  return (
    <>
      <FolderNotices listing={deepListing} />
      <div className={s.frame} data-phone={phone ? "" : undefined} data-files-keys="" {...osDrop}>
        <div className={s.bar}>
          {phone && (
            <IconButton label="Back" disabled={onPlaces} onClick={() => (phonePreview ? setPhonePreview(false) : back(sel.col))}>
              <NavArrowLeft />
            </IconButton>
          )}
          <PathLine folders={folders} onGo={(p) => f.go(p)} />
          <Segmented
            aria-label="Show this folder as"
            value={view}
            onChange={setView}
            options={[
              { value: "columns", label: null, icon: <ViewColumns3 />, ariaLabel: "Columns" },
              { value: "list", label: null, icon: <List />, ariaLabel: "List" },
              { value: "grid", label: null, icon: <ViewGrid />, ariaLabel: "Grid" },
            ]}
          />
          <Menu
            trigger={
              <IconButton label="View options">
                <MoreHoriz />
              </IconButton>
            }
            items={[
              { kind: "label", label: "Sort by" },
              ...(["name", "modified", "size", "kind"] as const).map((k) => ({ kind: "check" as const, label: { name: "Name", modified: "Date modified", size: "Size", kind: "Kind" }[k], checked: prefs.filesSort === k, onChange: () => void setPrefs({ filesSort: k }) })),
              "separator",
              { label: prefs.filesShowHidden ? "Hide hidden files" : "Show hidden files", icon: prefs.filesShowHidden ? <EyeClosed /> : <Eye />, onSelect: () => void setPrefs({ filesShowHidden: !prefs.filesShowHidden }) },
              { label: "Keyboard shortcuts", hint: "?", onSelect: f.showKeys },
            ]}
          />
        </div>

        <div className={s.strip} ref={strip} data-single={single ? "" : undefined}>
          <PlacesColumn current={folders[0]!} active={phone ? current === -1 : onPlaces} onGo={(p) => (setOnPlaces(false), f.go(p))} />
          {folders.slice(shownFrom, Math.max(firstBroken, shownFrom) + 1).map((folder, k) => {
              const col = shownFrom + k;
              const common = {
                folder,
                col,
                sel: sel.col === col ? sel : null,
                sort: order.sort,
                order: order.order,
                hidden: prefs.filesShowHidden,
                touch,
                renaming,
                writable: writableAt(col),
                cutPaths,
                onRows,
                ...handlersFor(col),
                phoneCurrent: phone ? (single ? !onPlaces && !(phonePreview && fileOpen) : current === col) : undefined,
              };
              return single ? <FolderPane key={folder} {...common} view={view as "list" | "grid"} admin={f.admin} active={!onPlaces} /> : <FolderColumn key={folder} {...common} open={folders[col + 1] ?? null} active={sel.col === col && !onPlaces} />;
            })}
          {!single && !showPreview && !phone && deepListing && deepListing.path === deepest && <FolderSummary listing={deepListing} />}
          {showPreview && <PreviewColumn entry={fileOpen!} phoneCurrent={phone ? current === folders.length : undefined} writable={writableAt(sel.col)} onRename={(e) => setRenaming({ path: e.path })} siblings={rowsOf(sel.col).filter((r): r is FileEntry => !!r && !isDirLike(r))} />}
        </div>

        <StatusLine selected={selected} size={selSize} listing={listings.current.get(folders[sel.col] ?? deepest) ?? deepListing} writable={writableAt(sel.col)} phone={phone} clipboard={!!clipboard && writableAt(last)} onPaste={() => void f.actions.paste(deepest)} onClear={clear} onRename={one && writableAt(sel.col) ? () => setRenaming({ path: one.path }) : undefined} onNewFolder={() => void newFolder()} onUpload={() => f.actions.pickFiles(deepest)} menu={selected.length ? menuFor(sel.col, selected) : []} dir={folders[sel.col] ?? deepest} />

        {dropping && (
          <div className={s.drop} data-refused={dropping.ok ? undefined : ""} aria-hidden>
            <Upload />
            {dropping.ok ? (
              <span>
                Drop to upload into <b>{baseName(dropping.into) || "Computer"}</b>
              </span>
            ) : (
              <span>{listings.current.get(deepest)?.protectedReason ?? "You can't upload into this folder."}</span>
            )}
          </div>
        )}
      </div>
    </>
  );
});

/** A folder that can't be listed, said plainly with the way out. */
function ErrorNotice({ error, path, onGo }: { error: ApiError; path: string; onGo: (p: string) => void }) {
  const { admin, go } = useFiles();
  const up = parentOf(path);
  if (error.code === "not_found")
    return (
      <div className={s.colNote}>
        <Notice title="This folder isn't there any more" action={path !== "/" ? <Button size="sm" onClick={() => onGo(up)}>Go up a level</Button> : undefined}>
          <span className="mono">{path}</span> may have been moved, renamed or deleted, or the drive it's on isn't connected.
        </Notice>
      </div>
    );
  if (error.code === "forbidden" || error.code === "in_trash")
    return (
      <div className={s.colNote}>
        {/* A member's way out is their own folders; the level above is likely closed to them too. */}
        <Notice title="You can't open this folder" action={admin ? <Button size="sm" onClick={() => onGo(up)}>Go up a level</Button> : <Button size="sm" onClick={() => go(null)}>Back to Files</Button>}>
          {error.message}
        </Notice>
      </div>
    );
  if (error.code === "not_a_folder")
    return (
      <div className={s.colNote}>
        <Notice title="That's a file, not a folder" action={<Button size="sm" onClick={() => onGo(up)}>Open the folder it's in</Button>}>
          <span className="mono">{path}</span>
        </Notice>
      </div>
    );
  return (
    <div className={s.colNote}>
      <Notice tone="fault" title={error.code === "network" ? "Can't reach the server" : "This folder couldn't be listed"}>
        {error.code === "network" ? "Check the connection; Files tries again when it's back." : error.message}
      </Notice>
    </div>
  );
}

function FolderNotices({ listing }: { listing: ListingT | undefined }) {
  if (!listing) return null;
  const notes: React.ReactNode[] = [];
  if (listing.access === "read") notes.push(<Notice key="ro" title="View only">This folder is shared with you to view. You can open and download files here, but not change them.</Notice>);
  else if (listing.protectedReason) notes.push(<Notice key="prot" title="View only here">{listing.protectedReason}</Notice>);
  if (listing.sortLimited) notes.push(<Notice key="big">This folder has {listing.total.toLocaleString()} items, so it's sorted by name. Sorting by size or date works in folders with fewer than 20,000 items.</Notice>);
  if (listing.truncated) notes.push(<Notice key="trunc" tone="attention" title="Only part of this folder is listed">It holds more than {(250_000).toLocaleString()} items; the first ones are shown. Use the bar above to search for the rest.</Notice>);
  return notes.length ? <div className={s.notices}>{notes}</div> : null;
}

// ---------------------------------------------------------------- the path, as text you can click or drop on

function PathLine({ folders, onGo }: { folders: string[]; onGo: (p: string) => void }) {
  const f = useFiles();
  const first = folders[0]!;
  const place = f.places?.places.find((p) => p.path === first);
  return (
    <nav className={s.path} aria-label="Folder path">
      <button type="button" className={s.pathPart} onClick={() => onGo(first)} title={first} aria-current={folders.length === 1 ? "location" : undefined}>
        {place?.label ?? (first === "/" ? "Computer" : baseName(first))}
      </button>
      {folders.slice(1).map((p, i) => (
        <React.Fragment key={p}>
          <span className={s.pathSep} aria-hidden>
            /
          </span>
          <PathPart path={p} last={i === folders.length - 2} onGo={onGo} />
        </React.Fragment>
      ))}
    </nav>
  );
}

function PathPart({ path, last, onGo }: { path: string; last: boolean; onGo: (p: string) => void }) {
  const f = useFiles();
  const drop = useDropTarget(last ? null : path, (src, dest, copy) => void f.actions.transfer(src, dest, copy ? "copy" : "move"));
  return (
    <button type="button" className={s.pathPart} data-drop={drop.over ? "" : undefined} onClick={() => !last && onGo(path)} title={path} aria-current={last ? "location" : undefined} {...drop.props}>
      {baseName(path)}
    </button>
  );
}

// ---------------------------------------------------------------- column 0: places

const GROUP_TITLE: Record<PlaceGroup, string> = { shared: "Shared with you", pins: "Pinned", drives: "Drives", people: "Home folders", apps: "App folders", recent: "Recent" };

function PlacesColumn({ current, active, onGo }: { current: string; active: boolean; onGo: (p: string) => void }) {
  const f = useFiles();
  const [renamingPin, setRenamingPin] = React.useState<Place | null>(null);
  if (!f.places) {
    return (
      <div className={`${s.col} ${s.placesCol}`}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} height={30} style={{ margin: "4px 8px" }} />
        ))}
      </div>
    );
  }
  const onDropItems = (src: string[], dest: string, copy: boolean) => void f.actions.transfer(src, dest, copy ? "copy" : "move");
  return (
    <nav className={`${s.col} ${s.placesCol}`} data-active={active ? "" : undefined} data-phone-current={active ? "" : undefined} aria-label="Places">
      {groupPlaces(f.places).map(([g, list]) => (
        <div key={g} className={s.placeGroup} role="group" aria-labelledby={`pl-${g}`}>
          <span className={`label ${s.placeLabel}`} id={`pl-${g}`}>
            {GROUP_TITLE[g]}
          </span>
          {g === "pins" ? <Pins pins={list} current={current} onGo={onGo} onDropItems={onDropItems} onRename={setRenamingPin} /> : list.map((p) => <PlaceRow key={p.id} place={p} on={p.path === current} onGo={onGo} onDropItems={onDropItems} />)}
        </div>
      ))}
      <div className={s.placeGroup}>
        <button type="button" className={s.place} onClick={f.openTrash}>
          <Trash className={s.placeIcon} aria-hidden />
          <span className={s.placeText}>
            <span className="truncate">Trash</span>
          </span>
        </button>
      </div>
      <RenamePin place={renamingPin} onClose={() => setRenamingPin(null)} />
    </nav>
  );
}

function PlaceRow({ place: p, on, onGo, onDropItems }: { place: Place; on: boolean; onGo: (p: string) => void; onDropItems: (src: string[], dest: string, copy: boolean) => void }) {
  const fmt = useFormat();
  const missing = p.missing || (p.kind === "drive" && !p.fs);
  const drop = useDropTarget(missing ? null : p.path, onDropItems, p.access === "write");
  const level = p.kind === "drive" || p.kind === "root" ? (p.fs ? fullness(p.fs.used, p.fs.size) : null) : null;
  const pct = p.fs?.size ? (p.fs.used / p.fs.size) * 100 : 0;
  return (
    <button
      type="button"
      className={s.place}
      data-on={on ? "" : undefined}
      data-drop={drop.over ? "" : undefined}
      data-missing={missing ? "" : undefined}
      aria-current={on ? "location" : undefined}
      onClick={() => onGo(p.path)}
      title={p.path}
      aria-label={[p.label, missing ? "not connected" : p.fs && level ? `${fmt.bytes(p.fs.avail)} free` : null].filter(Boolean).join(", ")}
      {...drop.props}
    >
      {p.kind === "drive" || p.kind === "root" ? <DiskGlyph media={p.media} className={s.placeIcon} /> : <PlaceIcon kind={p.kind} className={s.placeIcon} />}
      <span className={s.placeText}>
        <span className="truncate">{p.label}</span>
        {level && (
          <span className={s.meter} data-level={level} aria-hidden>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
        )}
        {missing && <span className={s.placeSub}>Not connected</span>}
      </span>
      {level === "fault" && <i className={s.faultMark} aria-hidden />}
    </button>
  );
}

function Pins({ pins, current, onGo, onDropItems, onRename }: { pins: Place[]; current: string; onGo: (p: string) => void; onDropItems: (src: string[], dest: string, copy: boolean) => void; onRename: (p: Place) => void }) {
  const f = useFiles();
  const [list, setList] = React.useState(pins);
  React.useEffect(() => setList(pins), [pins]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = list.map((p) => p.id);
    const next = arrayMove(list, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setList(next);
    try {
      await api.patch("/api/me/pins", { order: next.map((p) => p.pinned!.id) });
      void globalMutate("/api/shell");
      f.refresh();
    } catch (err) {
      setList(pins);
      toast.error("Couldn't reorder pins", { description: err instanceof Error ? err.message : undefined });
    }
  };
  const unpin = async (p: Place) => {
    try {
      await api.del("/api/me/pins", { id: p.pinned!.id });
      void globalMutate("/api/shell");
      f.refresh();
    } catch (err) {
      toast.error("Couldn't unpin", { description: err instanceof Error ? err.message : undefined });
    }
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onEnd(e)}>
      <SortableContext items={list.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        {list.map((p) => (
          <PinRow key={p.id} place={p} on={p.path === current} onGo={onGo} onDropItems={onDropItems} onRename={() => onRename(p)} onUnpin={() => void unpin(p)} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function PinRow({ place: p, on, onGo, onDropItems, onRename, onUnpin }: { place: Place; on: boolean; onGo: (p: string) => void; onDropItems: (src: string[], dest: string, copy: boolean) => void; onRename: () => void; onUnpin: () => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: p.id });
  const drop = useDropTarget(p.missing ? null : p.path, onDropItems);
  return (
    <div ref={setNodeRef} className={s.pinRow} data-dragging={isDragging ? "" : undefined} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button type="button" className={s.pinGrip} {...attributes} {...listeners} aria-label={`Move ${p.label}`}>
        <Drag />
      </button>
      <button type="button" className={s.place} data-on={on ? "" : undefined} data-drop={drop.over ? "" : undefined} data-missing={p.missing ? "" : undefined} onClick={() => !p.missing && onGo(p.path)} title={p.missing ? `${p.path} is gone` : p.path} {...drop.props}>
        <PlaceIcon kind="pin" className={s.placeIcon} />
        <span className={s.placeText}>
          <span className="truncate">{p.label}</span>
          {p.missing && <span className={s.placeSub}>Gone</span>}
        </span>
      </button>
      <Menu
        trigger={
          <IconButton label={`${p.label} options`} size="sm" className={s.pinMenu} tooltip={false}>
            <MoreHoriz />
          </IconButton>
        }
        items={[
          { label: "Rename pin", icon: <EditPencil />, onSelect: onRename },
          { label: "Unpin", icon: <PinSlash />, onSelect: onUnpin },
        ]}
      />
    </div>
  );
}

function RenamePin({ place, onClose }: { place: Place | null; onClose: () => void }) {
  const f = useFiles();
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setLabel(place?.label ?? ""), [place]);
  const save = async () => {
    if (!place || !label.trim()) return;
    setBusy(true);
    try {
      await api.patch("/api/me/pins", { id: place.pinned!.id, label: label.trim() });
      void globalMutate("/api/shell");
      f.refresh();
      onClose();
    } catch (e) {
      toast.error("Couldn't rename the pin", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!place}
      onOpenChange={(o) => !o && onClose()}
      title="Rename pin"
      description={place ? <span className="mono">{place.path}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name in the sidebar" description="Only changes the pin's name, not the folder.">
          <Input autoFocus value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- one folder's listing, shared by columns and panes

interface ColumnHandlers {
  onChoose: (i: number, ev?: Pick) => void;
  onToggle: (i: number) => void;
  onOpen: (i: number) => void;
  onKey: (ev: React.KeyboardEvent, grid: { cols: number } | null) => void;
  onRenameCommit: (e: FileEntry, name: string) => void;
  onRenameCancel: () => void;
  menuFor: (entries: FileEntry[]) => MenuEntry[];
  backgroundMenu: () => MenuEntry[];
  onDropItems: (src: string[], dest: string, copy: boolean) => void;
  /** What a drag from this row carries: the whole selection when the row is in it. */
  dragFrom: (path: string) => string[];
  refCb: (el: HTMLDivElement | null) => void;
}

interface FolderProps extends ColumnHandlers {
  folder: string;
  col: number;
  sel: Sel | null;
  sort: SortKey;
  order: "asc" | "desc";
  hidden: boolean;
  touch: boolean;
  renaming: { path: string; draft?: string } | null;
  writable: boolean;
  cutPaths: Set<string> | null;
  phoneCurrent?: boolean;
  onRows: (folder: string, rows: (FileEntry | undefined)[], listing: ListingT | undefined, refresh: () => void, ensure: (i: number) => void, error: ApiError | null, loadAll: () => Promise<FileEntry[]>) => void;
}

function useFolder(p: FolderProps) {
  const L = useListing({ path: p.folder, sort: p.sort, order: p.order, hidden: p.hidden, filter: "" });
  const { onRows } = p;
  React.useEffect(() => {
    onRows(p.folder, L.rows, L.listing, () => void L.refresh(), L.ensure, L.error ?? null, L.loadAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.rows, L.listing, L.error, p.folder, onRows]);
  const max = React.useMemo(() => L.rows.reduce((m, r) => Math.max(m, r ? (sizeOf(r) ?? 0) : 0), 0), [L.rows]);
  const selfDrop = useDropTarget(p.folder, p.onDropItems, p.writable);
  const [ctx, setCtx] = React.useState<MenuEntry[]>([]);
  const onContextMenu = (ev: React.MouseEvent) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-index]");
    const e = el ? L.rows[Number(el.dataset.index)] : undefined;
    if (!e) return setCtx(p.backgroundMenu());
    const inSel = p.sel?.paths.has(e.path) && p.sel.paths.size > 1;
    if (!inSel && !p.sel?.paths.has(e.path)) p.onChoose(Number(el!.dataset.index));
    setCtx(p.menuFor(inSel ? L.rows.filter((r): r is FileEntry => !!r && p.sel!.paths.has(r.path)) : [e]));
  };
  return { L, max, selfDrop, ctx, onContextMenu };
}

function FolderState({ L, folder }: { L: ReturnType<typeof useListing>; folder: string }) {
  const f = useFiles();
  const fmt = useFormat();
  if (L.error) return <ErrorNotice error={L.error} path={folder} onGo={(p) => f.go(p)} />;
  if (!L.listing) return <>{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} height={14} width={`${45 + ((i * 29) % 45)}%`} style={{ margin: "10px 12px" }} />)}</>;
  const l = L.listing;
  const w = l.access === "write" && !l.protectedReason;
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{l.counts.hidden ? `Only ${fmt.plural(l.counts.hidden, "hidden item")} here` : "Empty folder"}</p>
      <p className={s.emptyText}>{w ? "Drag files here from your computer, or:" : "Nothing has been put here yet."}</p>
      {w && (
        <span className={s.emptyActions}>
          <Button size="sm" icon={<Upload />} onClick={() => f.actions.pickFiles(folder)}>
            Upload
          </Button>
          <Button size="sm" variant="ghost" icon={<FolderPlus />} onClick={() => f.browser.current?.newFolder()}>
            New folder
          </Button>
        </span>
      )}
    </div>
  );
}

/** One column of the column view: a folder's contents, virtualised, with the open folder marked. */
function FolderColumn(p: FolderProps & { open: string | null; active: boolean }) {
  const { L, selfDrop, ctx, onContextMenu } = useFolder(p);
  const scroller = React.useRef<HTMLDivElement>(null);
  const rowH = p.touch ? ROW_TOUCH : ROW;
  const v = useVirtualizer({ count: L.total, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: 12 });
  const items = v.getVirtualItems();
  React.useEffect(() => {
    for (const it of items) L.ensure(it.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.index).join(",")]);
  const focusIdx = p.sel?.focus ?? -1;
  const openIdx = p.open ? L.rows.findIndex((r) => r?.path === p.open) : -1;
  React.useEffect(() => {
    const i = focusIdx >= 0 ? focusIdx : openIdx;
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIdx, openIdx]);
  const fmt = useFormat();

  return (
    <ContextMenu items={ctx} disabled={p.touch}>
      <div
        ref={p.refCb}
        className={s.col}
        data-col-path={p.folder}
        data-active={p.active ? "" : undefined}
        data-phone-current={p.phoneCurrent ? "" : undefined}
        data-drop={selfDrop.over ? "" : undefined}
        role="listbox"
        aria-multiselectable
        aria-label={baseName(p.folder) || "Computer"}
        aria-activedescendant={p.sel && p.sel.focus >= 0 ? `c${p.col}-${p.sel.focus}` : undefined}
        tabIndex={p.active ? 0 : -1}
        onKeyDown={(ev) => p.onKey(ev, null)}
        onContextMenu={onContextMenu}
        {...selfDrop.props}
      >
        <div ref={scroller} className={s.colScroll}>
          {!L.listing || L.error || !L.total ? (
            <FolderState L={L} folder={p.folder} />
          ) : (
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {items.map((it) => {
                const e = L.rows[it.index];
                return (
                  <div key={it.key} className={s.vrow} style={{ transform: `translateY(${it.start}px)`, height: rowH }}>
                    {e ? (
                      <ColRow
                        id={`c${p.col}-${it.index}`}
                        entry={e}
                        index={it.index}
                        open={p.open === e.path}
                        selected={!!p.sel?.paths.has(e.path)}
                        focused={p.sel?.focus === it.index}
                        share={null}
                        renaming={p.renaming?.path === e.path ? p.renaming : null}
                        writable={p.writable}
                        touch={p.touch}
                        cut={!!p.cutPaths?.has(e.path)}
                        dragFrom={p.dragFrom}
                        selecting={!!p.sel && p.sel.paths.size > 1}
                        onChoose={p.onChoose}
                        onToggle={p.onToggle}
                        onOpen={p.onOpen}
                        onRenameCommit={p.onRenameCommit}
                        onRenameCancel={p.onRenameCancel}
                        onDropItems={p.onDropItems}
                      />
                    ) : (
                      <Skeleton height={12} width="60%" style={{ margin: "11px 12px" }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {L.listing && (
          <div className={`${s.colFoot} num`} aria-hidden>
            {fmt.plural(L.total, "item")}
            {L.listing.access === "read" && " · view only"}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}

interface RowProps {
  id: string;
  entry: FileEntry;
  index: number;
  open?: boolean;
  selected: boolean;
  focused: boolean;
  share: number | null;
  renaming: { path: string; draft?: string } | null;
  writable: boolean;
  touch: boolean;
  cut: boolean;
  selecting: boolean;
  dragFrom: (path: string) => string[];
  onChoose: (i: number, ev?: Pick) => void;
  onToggle: (i: number) => void;
  onOpen: (i: number) => void;
  onRenameCommit: (e: FileEntry, name: string) => void;
  onRenameCancel: () => void;
  onDropItems: (src: string[], dest: string, copy: boolean) => void;
}

/** Click, double-click, long-press on touch, drag out and drop in: what every row and tile does. */
function useItem(p: RowProps) {
  const e = p.entry;
  const dir = isDirLike(e);
  const drop = useDropTarget(dir && !e.link?.outside ? e.path : null, p.onDropItems, p.writable);
  const press = React.useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current && !press.current.fired) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  };
  const props = {
    id: p.id,
    "data-index": p.index,
    "data-dir-path": dir ? e.path : undefined,
    "aria-selected": p.selected,
    "data-focused": p.focused ? "" : undefined,
    "data-drop": drop.over ? "" : undefined,
    "data-cut": p.cut ? "" : undefined,
    "data-hidden": e.hidden ? "" : undefined,
    draggable: p.writable && !p.renaming && !p.touch,
    onDragStart: (ev: React.DragEvent) => {
      ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(p.dragFrom(e.path)));
      ev.dataTransfer.effectAllowed = "copyMove";
    },
    onPointerDown: (ev: React.PointerEvent) => {
      if (ev.pointerType !== "touch" || (ev.target as HTMLElement).closest("button,input")) return;
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        if (!p.selected) p.onToggle(p.index);
        navigator.vibrate?.(8);
      }, LONG_PRESS);
      press.current = { timer, x: ev.clientX, y: ev.clientY, fired: false };
    },
    onPointerMove: (ev: React.PointerEvent) => {
      const c = press.current;
      if (c && !c.fired && Math.hypot(ev.clientX - c.x, ev.clientY - c.y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClick: (ev: React.MouseEvent) => {
      if (press.current?.fired) {
        press.current = null;
        return;
      }
      if ((ev.target as HTMLElement).closest("button,input")) return;
      // On touch screens a tap opens, unless you're picking several.
      const touch = p.touch || (ev.nativeEvent as PointerEvent).pointerType === "touch";
      if (touch && p.selecting) return p.onToggle(p.index);
      if (touch && !dir) return p.onOpen(p.index);
      p.onChoose(p.index, ev);
    },
    onDoubleClick: (ev: React.MouseEvent) => {
      if (p.touch || (ev.target as HTMLElement).closest("button,input")) return;
      p.onOpen(p.index);
    },
    ...drop.props,
  };
  return { dir, props };
}

function SizeText({ e, dir }: { e: FileEntry; dir: boolean }) {
  const fmt = useFormat();
  if (e.link?.broken) return <span className={s.broken}>broken link</span>;
  if (!dir) return <>{fmt.bytes(e.size)}</>;
  // An unknown size shows nothing; measuring is in the menu and Properties.
  return e.dirSize ? <span title={`Measured ${fmt.relative(e.dirSize.computedAt)}`}>{fmt.bytes(e.dirSize.bytes)}</span> : null;
}

const ColRow = React.memo(function ColRow(p: RowProps) {
  const { dir, props } = useItem(p);
  const e = p.entry;
  return (
    <div className={s.row} role="option" data-open={p.open ? "" : undefined} {...props}>
      <KindIcon kind={e.kind} type={e.type} className={s.rowIcon} />
      {p.renaming ? (
        <RenameField entry={e} initial={p.renaming.draft} onCommit={(n) => p.onRenameCommit(e, n)} onCancel={p.onRenameCancel} />
      ) : (
        <span className={s.rowName} title={e.name}>
          {e.name}
        </span>
      )}
      {dir ? (
        <span className={s.rowEnd}>
          <span className={`${s.rowSize} num`}>
            <SizeText e={e} dir />
          </span>
          <NavArrowRight className={s.chev} aria-hidden />
        </span>
      ) : (
        <span className={`${s.rowSize} num`}>
          <SizeText e={e} dir={false} />
        </span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- the deepest folder as a list or a grid

function FolderPane(p: FolderProps & { view: "list" | "grid"; admin: boolean; active: boolean }) {
  const { L, max, selfDrop, ctx, onContextMenu } = useFolder(p);
  const fmt = useFormat();
  const scroller = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(800);
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 24));
    ro.observe(el);
    setWidth(el.clientWidth - 24);
    return () => ro.disconnect();
  }, []);
  const grid = p.view === "grid";
  // Phones fit three photos across, like a camera roll.
  const min = width < 520 ? 96 : TILE_MIN;
  const cols = grid ? Math.max(2, Math.floor((width + TILE_GAP) / (min + TILE_GAP))) : 1;
  const tileW = grid ? (width - TILE_GAP * (cols - 1)) / cols : 0;
  const lineH = grid ? Math.round(tileW + 52 + TILE_GAP) : p.touch ? 56 : LIST_ROW;
  const count = grid ? Math.ceil(L.total / cols) : L.total;
  const v = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => lineH, overscan: 6 });
  React.useEffect(() => v.measure(), [lineH, v]);
  const items = v.getVirtualItems();
  React.useEffect(() => {
    for (const it of items) L.ensure(it.index * cols);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.index).join(","), cols]);
  const focusIdx = p.sel?.focus ?? -1;
  React.useEffect(() => {
    if (focusIdx >= 0) v.scrollToIndex(Math.floor(focusIdx / cols), { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIdx, cols]);

  const rowProps = (e: FileEntry, i: number): RowProps => ({
    id: `c${p.col}-${i}`,
    entry: e,
    index: i,
    selected: !!p.sel?.paths.has(e.path),
    focused: p.sel?.focus === i,
    share: max ? (sizeOf(e) ?? 0) / max : null,
    renaming: p.renaming?.path === e.path ? p.renaming : null,
    writable: p.writable,
    touch: p.touch,
    cut: !!p.cutPaths?.has(e.path),
    selecting: !!p.sel && p.sel.paths.size > 0,
    dragFrom: p.dragFrom,
    onChoose: p.onChoose,
    onToggle: p.onToggle,
    onOpen: p.onOpen,
    onRenameCommit: p.onRenameCommit,
    onRenameCancel: p.onRenameCancel,
    onDropItems: p.onDropItems,
  });

  return (
    <ContextMenu items={ctx} disabled={p.touch}>
      <div
        ref={p.refCb}
        className={`${s.col} ${s.pane}`}
        data-col-path={p.folder}
        data-view={p.view}
        data-admin={p.admin ? "" : undefined}
        data-active={p.active ? "" : undefined}
        data-phone-current={(p.phoneCurrent ?? true) ? "" : undefined}
        data-drop={selfDrop.over ? "" : undefined}
        role="grid"
        aria-multiselectable
        aria-rowcount={count}
        aria-label={baseName(p.folder) || "Computer"}
        aria-activedescendant={p.sel && p.sel.focus >= 0 ? `c${p.col}-${p.sel.focus}` : undefined}
        tabIndex={0}
        onKeyDown={(ev) => p.onKey(ev, grid ? { cols } : null)}
        onContextMenu={onContextMenu}
        {...selfDrop.props}
      >
        {!grid && L.listing && L.total > 0 && (
          <div className={s.listHead} role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader" className={s.lSize}>
              Size
            </span>
            <span role="columnheader" className={s.lDate}>
              Modified
            </span>
            <span role="columnheader" className={s.lOwner}>
              Owner
            </span>
          </div>
        )}
        <div ref={scroller} className={s.colScroll} data-pad={grid ? "" : undefined}>
          {!L.listing || L.error || !L.total ? (
            <FolderState L={L} folder={p.folder} />
          ) : (
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {items.map((it) => {
                if (!grid) {
                  const e = L.rows[it.index];
                  return (
                    <div key={it.key} className={s.vrow} style={{ transform: `translateY(${it.start}px)`, height: lineH }}>
                      {e ? <ListRow {...rowProps(e, it.index)} /> : <Skeleton height={12} width="50%" style={{ margin: "14px 16px" }} />}
                    </div>
                  );
                }
                const start = it.index * cols;
                return (
                  <div key={it.key} className={s.vgrid} role="row" style={{ transform: `translateY(${it.start}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: TILE_GAP }}>
                    {Array.from({ length: cols }, (_, k) => {
                      const i = start + k;
                      if (i >= L.total) return <span key={k} />;
                      const e = L.rows[i];
                      return e ? <Tile key={e.path} {...rowProps(e, i)} size={tileW} /> : <Skeleton key={k} height={lineH - TILE_GAP} radius={10} />;
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {L.listing && (
          <div className={`${s.colFoot} num`} aria-hidden>
            {fmt.plural(L.total, "item")}
            {L.listing.access === "read" && " · view only"}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}

const ListRow = React.memo(function ListRow(p: RowProps) {
  const { dir, props } = useItem(p);
  const e = p.entry;
  return (
    <div className={s.lrow} role="row" {...props}>
      <span role="gridcell" className={s.lName}>
        <span className={s.lFace}>
          <Thumb item={e} size={160} />
        </span>
        <span className={s.lText}>
          {p.renaming ? (
            <RenameField entry={e} initial={p.renaming.draft} onCommit={(n) => p.onRenameCommit(e, n)} onCancel={p.onRenameCancel} />
          ) : (
            <span className={s.lLabel} title={e.name}>
              {e.name}
              {e.link && !e.link.broken && <span className={`${s.linkTo} mono`}>→ {e.link.target}</span>}
            </span>
          )}
          <SizeRule share={p.share} className={s.lRule} />
          <span className={`${s.lMeta} num`}>
            <SizeText e={e} dir={dir} /> · <FileTime ts={e.mtime} />
          </span>
        </span>
      </span>
      <span role="gridcell" className={`${s.lSize} num`}>
        <SizeText e={e} dir={dir} />
      </span>
      <span role="gridcell" className={`${s.lDate} num`}>
        <FileTime ts={e.mtime} />
      </span>
      <span role="gridcell" className={`${s.lOwner} mono`} title={`${e.owner ?? e.uid}:${e.group ?? e.gid} ${e.mode}`}>
        {e.owner ?? e.uid}
      </span>
    </div>
  );
});

// What a folder tile shows: its poster or cover if it has one, else up to four photos from inside.
const COVER = /^(poster|cover|folder|front)\.(jpe?g|png|webp)$/i;
const faces = new Map<string, Promise<{ cover: string | null; mosaic: string[] }>>();
function folderFace(path: string) {
  let p = faces.get(path);
  if (!p) {
    p = api
      .get<ListingT>(`/api/files/list?path=${encodeURIComponent(path)}&limit=200&sort=name`)
      .then((l) => {
        const cover = l.entries.find((e) => COVER.test(e.name));
        const photos = l.entries.filter((e) => !isDirLike(e) && THUMBABLE.test(e.name)).slice(0, 4);
        return { cover: cover ? thumbUrl(cover, 320) : null, mosaic: photos.map((e) => thumbUrl(e, 160)) };
      })
      .catch(() => ({ cover: null, mosaic: [] }));
    faces.set(path, p);
    if (faces.size > 400) faces.delete(faces.keys().next().value!);
  }
  return p;
}

const Tile = React.memo(function Tile(p: RowProps & { size: number }) {
  const { dir, props } = useItem(p);
  const e = p.entry;
  const fmt = useFormat();
  const [face, setFace] = React.useState<{ cover: string | null; mosaic: string[] } | null>(null);
  React.useEffect(() => {
    if (!dir) return;
    let live = true;
    void folderFace(e.path).then((x) => live && setFace(x));
    return () => {
      live = false;
    };
  }, [dir, e.path]);
  const pictured = dir && face && (face.cover || face.mosaic.length > 0);
  return (
    <div className={s.tile} role="gridcell" aria-label={e.name} {...props}>
      <span className={s.tileFace} style={{ height: p.size }} data-dir={dir ? "" : undefined}>
        {pictured ? (
          face!.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={s.cover} src={face!.cover} alt="" loading="lazy" />
          ) : (
            <span className={s.mosaic} data-n={face!.mosaic.length}>
              {face!.mosaic.map((m) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={m} src={m} alt="" loading="lazy" />
              ))}
            </span>
          )
        ) : (
          <Thumb item={e} size={320} />
        )}
        {pictured && (
          <span className={s.folderTab} aria-hidden>
            <Folder />
          </span>
        )}
        <button type="button" className={s.pick} aria-pressed={p.selected} aria-label={p.selected ? `Unselect ${e.name}` : `Select ${e.name}`} onClick={() => p.onToggle(p.index)} data-visible={p.selecting ? "" : undefined} tabIndex={-1}>
          <Check aria-hidden />
        </button>
      </span>
      <span className={s.tileText}>
        {p.renaming ? (
          <RenameField entry={e} initial={p.renaming.draft} onCommit={(n) => p.onRenameCommit(e, n)} onCancel={p.onRenameCancel} />
        ) : (
          <span className={s.tileName} title={e.name}>
            {e.name}
          </span>
        )}
        <span className={`${s.tileSub} num`}>{e.link?.broken ? "Broken link" : dir ? (e.dirSize ? fmt.bytes(e.dirSize.bytes) : "Folder") : <>{fmt.bytes(e.size)} · <FileTime ts={e.mtime} /></>}</span>
      </span>
    </div>
  );
});

// ---------------------------------------------------------------- the end: the file itself

function PreviewColumn({ entry, phoneCurrent, writable, onRename, siblings }: { entry: FileEntry; phoneCurrent?: boolean; writable: boolean; onRename: (e: FileEntry) => void; siblings: FileEntry[] }) {
  const f = useFiles();
  const look = () => f.look(entry, siblings);
  return (
    <section className={`${s.col} ${s.previewCol}`} data-phone-current={phoneCurrent ? "" : undefined} aria-label={`Preview of ${entry.name}`}>
      <div className={s.colScroll}>
        <div className={s.previewInner}>
          <div className={s.stage} data-kind={entry.preview ?? "none"}>
            <PreviewBody entry={entry} textHeight="300px" canExtract={writable} onExtract={(e) => void f.actions.extract(e)} />
          </div>
          <h2 className={s.previewName}>{entry.name}</h2>
          <div className={s.previewActions}>
            <Button size="sm" variant="primary" icon={<Download />} onClick={() => void f.actions.download([entry])}>
              Download
            </Button>
            {entry.preview && (
              <Button size="sm" icon={<Eye />} onClick={look}>
                Quick look
              </Button>
            )}
            {writable && (
              <IconButton label="Rename" size="sm" shortcut="F2" onClick={() => onRename(entry)}>
                <EditPencil />
              </IconButton>
            )}
          </div>
          <Facts entry={entry} admin={f.admin} />
          {f.admin && isDirLike(entry) && <UsedBy path={entry.path} />}
        </div>
      </div>
    </section>
  );
}

/** With nothing open at the end of the columns: what this folder holds, where it lives, who uses it. */
function FolderSummary({ listing: l }: { listing: ListingT }) {
  const f = useFiles();
  const fmt = useFormat();
  const c = l.counts;
  const files = c.files + c.links + c.other;
  const parts = [c.dirs ? fmt.plural(c.dirs, "folder") : null, files ? fmt.plural(files, "file") : null].filter(Boolean);
  const drive = l.fs ? f.places?.places.find((p) => (p.kind === "drive" || p.kind === "root") && p.path === l.fs!.mount) : undefined;
  const rows: [string, React.ReactNode][] = [
    ["Holds", <span key="h" className="num">{parts.length ? parts.join(" and ") : c.hidden ? `Only ${fmt.plural(c.hidden, "hidden item")}` : "Nothing yet"}</span>],
    ...(l.self.dirSize ? ([["Size", <span key="s" className="num">{fmt.bytes(l.self.dirSize.bytes)}</span>]] as [string, React.ReactNode][]) : []),
    ...(l.fs ? ([["Drive", <span key="d" className="num">{fmt.bytes(l.fs.avail)} free of {fmt.bytes(l.fs.size)}{f.admin && drive ? ` on ${drive.label}` : ""}</span>]] as [string, React.ReactNode][]) : []),
    ["Modified", <FileTime key="m" ts={l.self.mtime} />],
    ["You can", l.access === "write" && !l.protectedReason ? "Look, add and change things" : "Look and download"],
  ];
  return (
    <section className={`${s.col} ${s.previewCol} ${s.summaryCol}`} aria-label={`About ${l.name || "this folder"}`}>
      <div className={s.colScroll}>
        <div className={s.previewInner}>
          <h2 className={s.previewName}>{l.path === "/" ? "Computer" : l.name}</h2>
          <dl className={s.summaryList}>
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          {f.admin && <UsedBy path={l.path} onFixOwnership={(p) => f.actions.fixOwnership(p)} />}
          <p className={s.summaryHint}>Select something to see it here.</p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the status line under it all

function StatusLine(p: {
  selected: FileEntry[];
  size: string | null;
  listing: ListingT | undefined;
  writable: boolean;
  phone: boolean;
  clipboard: boolean;
  onPaste: () => void;
  onClear: () => void;
  onRename?: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  menu: MenuEntry[];
  dir: string;
}) {
  const f = useFiles();
  const fmt = useFormat();
  const n = p.selected.length;
  const paths = p.selected.map((e) => e.path);
  const l = p.listing;
  return (
    <div className={s.status} role="toolbar" aria-label={n ? `${fmt.plural(n, "item")} selected` : "This folder"}>
      <span className={`${s.statusText} num`} aria-live="polite">
        {n ? (
          <>
            <b>{n === 1 ? p.selected[0]!.name : `${fmt.plural(n, "item")} selected`}</b>
            {p.size && <span className="muted"> · {p.size}</span>}
          </>
        ) : l ? (
          <>
            <b>{l.path === "/" ? "Computer" : l.name}</b>
            <span className="muted">
              {" "}
              · {fmt.plural(l.total, "item")}
              {l.fs && !p.phone ? ` · ${fmt.bytes(l.fs.avail)} free` : ""}
            </span>
          </>
        ) : (
          <Skeleton width={180} height={12} />
        )}
      </span>
      <span className={s.statusActions}>
        {n ? (
          <>
            <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void f.actions.download(p.selected)} aria-label={p.phone ? "Download" : undefined}>
              {p.phone ? undefined : "Download"}
            </Button>
            {!p.phone && (
              <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => f.actions.copyTo(paths)}>
                Copy to…
              </Button>
            )}
            {p.writable && (
              <Button size="sm" variant="ghost" icon={<DataTransferBoth />} onClick={() => f.actions.moveTo(paths)} aria-label={p.phone ? "Move to…" : undefined}>
                {p.phone ? undefined : "Move to…"}
              </Button>
            )}
            {p.onRename && !p.phone && (
              <Button size="sm" variant="ghost" icon={<EditPencil />} onClick={p.onRename}>
                Rename
              </Button>
            )}
            {p.writable && (
              <Button size="sm" variant="ghost" icon={<Trash />} onClick={() => void f.actions.trash(p.selected, p.onClear)} aria-label={p.phone ? "Move to the trash" : undefined}>
                {p.phone ? undefined : "Trash"}
              </Button>
            )}
            <Menu side="top" trigger={<IconButton label="More actions" size="sm"><MoreHoriz /></IconButton>} items={p.menu} />
            <IconButton label="Clear selection" size="sm" shortcut="Esc" onClick={p.onClear}>
              <Xmark />
            </IconButton>
          </>
        ) : p.writable ? (
          <>
            {p.clipboard && (
              <Button size="sm" variant="ghost" icon={<PasteClipboard />} onClick={p.onPaste} aria-label={p.phone ? "Paste" : undefined}>
                {p.phone ? undefined : "Paste"}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<FolderPlus />} onClick={p.onNewFolder} aria-label={p.phone ? "New folder" : undefined}>
              {p.phone ? undefined : "New folder"}
            </Button>
            <Button size="sm" icon={<Upload />} onClick={p.onUpload}>
              Upload
            </Button>
          </>
        ) : null}
      </span>
    </div>
  );
}

