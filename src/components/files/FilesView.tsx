"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { mutate as globalMutate } from "swr";
import {
  Archive,
  Copy,
  Download,
  EditPencil,
  EyeClosed,
  Eye,
  FolderPlus,
  InfoCircle,
  List,
  MoreHoriz,
  NavArrowLeft,
  OpenInWindow,
  Pin,
  PinSlash,
  Search,
  SidebarCollapse,
  SidebarExpand,
  SortDown,
  SortUp,
  Trash,
  Upload,
  UserCrown,
  ViewGrid,
  Xmark,
  DataTransferBoth,
  Refresh,
  Scissor,
  PasteClipboard,
  MultiplePages,
  PagePlus,
} from "iconoir-react";
import type { FileEntry, FileJob, FolderSize, Listing as ListingT, Places, SearchHit, TrashSummary, UploadSession, ZipEstimate } from "@/lib/files-types";
import { api, ApiError, useApi, useStream } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { useListing } from "./useListing";
import { Listing, ListingSkeleton, type ClipOp } from "./Listing";
import { Rail } from "./Rail";
import { PathBar } from "./PathBar";
import { Preview } from "./Preview";
import { Properties, copyText } from "./Properties";
import { Ownership } from "./Ownership";
import { FolderPicker } from "./FolderPicker";
import { Tray } from "./Tray";
import { Shortcuts } from "./Shortcuts";
import { TrashView } from "./TrashView";
import { SearchResults } from "./SearchResults";
import { useConflicts } from "./Conflicts";
import { uploads } from "./uploads";
import { readDrop, fromInput, type Incoming } from "./drop";
import { clip, useClip } from "./clip";
import { baseName, downloadUrl, filesHref, isArchive, isDirLike, joinPath, modKey, parentOf, prefFromSort, rawUrl, sortFromPref, useMediaQuery } from "./lib";
import s from "./files.module.css";

type Where = { path: string; view: "files" | "trash" };

function readLocation(fallback: string): Where {
  if (typeof window === "undefined") return { path: fallback, view: "files" };
  const q = new URLSearchParams(window.location.search);
  return { path: q.get("path") || fallback, view: q.get("view") === "trash" ? "trash" : "files" };
}

const SIZE_STALE_MS = 60 * 60_000;
/** Focused things that use the keyboard themselves; anywhere else, Files keys go to the list. */
const KEY_OWNERS = "input,textarea,select,[contenteditable],[role=menu],[role=menuitem],[role=dialog],[role=alertdialog],[role=listbox],[role=option],[role=combobox],[role=radiogroup],[role=radio],[role=tablist],[role=tab],[role=slider],[role=grid]";

/** Don't re-measure a folder that was measured this recently, however much changes. */
const SIZE_REST_MS = 30_000;

/** A measured size is out of date when the folder itself changed after it (something added or removed). */
const staleSize = (e: FileEntry) => !!e.dirSize && e.mtime > e.dirSize.computedAt + 1000;

/**
 * Folder sizes, filled in without being asked: when a folder opens with sub-folders whose size isn't
 * known (or its own measurement is over an hour old), the server measures it once (du, one level
 * deep, so every sub-folder's size comes from the same pass, at most two at a time) and the list
 * refreshes when it's done. `measuring` drives the placeholder in the Size column.
 */
function useFolderSizes(listing: ListingT | undefined, onDone: () => void) {
  const [measuring, setMeasuring] = React.useState(false);
  const done = React.useRef(onDone);
  done.current = onDone;
  const path = listing?.path ?? null;
  const self = listing?.self;
  const changed = !!listing && (!self?.dirSize || staleSize(self) || listing.entries.some((e) => e.type === "dir" && (!e.dirSize || staleSize(e))));
  const needs = !!listing && listing.counts.dirs > 0 && (changed || Date.now() - (self?.dirSize?.computedAt ?? 0) > SIZE_STALE_MS);
  const before = self?.dirSize?.computedAt ?? 0;
  React.useEffect(() => {
    setMeasuring(false);
    if (!path || !needs) return;
    let live = true;
    const url = `/api/files/size?path=${encodeURIComponent(path)}`;
    // Something inside changed since the last measurement: measure again (unless that was moments ago).
    const again = changed && Date.now() - before > SIZE_REST_MS;
    void (async () => {
      let r = await api.get<FolderSize>(again ? `${url}&refresh=1` : url);
      if (!live) return;
      if (!r.running) {
        if ((r.computedAt ?? 0) > before) done.current();
        return;
      }
      setMeasuring(true);
      // Poll gently: often seconds, sometimes minutes on a big media drive (du stops at 20 min).
      for (let i = 0; live && r.running && i < 400; i++) {
        await new Promise((ok) => setTimeout(ok, Math.min(1200 + i * 400, 5000)));
        if (!live) return;
        r = await api.get<FolderSize>(url);
      }
      if (!live) return;
      setMeasuring(false);
      done.current();
    })().catch(() => live && setMeasuring(false));
    return () => {
      live = false;
    };
    // Once per folder visit; the refresh that follows must not start another round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, needs]);
  return measuring;
}

export function FilesView({ initialPlaces, defaultPath }: { initialPlaces: Places | null; defaultPath: string }) {
  const fmt = useFormat();
  const { prefs, setPrefs, viewer } = usePrefs();
  const isAdmin = viewer.role === "admin";
  const search = useSearchParams();
  const path = search.get("path") || defaultPath;
  const view: Where["view"] = search.get("view") === "trash" ? "trash" : "files";
  const phone = useMediaQuery("(max-width: 900px)");
  const touch = useMediaQuery("(hover: none) and (pointer: coarse)");
  const mod = React.useMemo(() => (typeof window === "undefined" ? "Ctrl+" : modKey()), []);

  // ---- preferences
  const natural = sortFromPref(prefs.filesSort);
  const [orderOverride, setOrderOverride] = React.useState<{ sort: string; order: "asc" | "desc" } | null>(null);
  const sort = natural.sort;
  const order = orderOverride && orderOverride.sort === sort ? orderOverride.order : natural.order;
  const [filterText, setFilterText] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [deepQuery, setDeepQuery] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setFilter(filterText.trim()), 220);
    return () => clearTimeout(t);
  }, [filterText]);

  // ---- data
  const places = useApi<Places>("/api/files/places", { fallbackData: initialPlaces ?? undefined, refresh: 60_000 });
  const L = useListing({ path: view === "files" ? path : null, sort, order, hidden: prefs.filesShowHidden, filter });
  const listing = L.listing;
  const trash = useApi<TrashSummary>(view === "trash" ? "/api/files/trash" : null);
  const writable = !!listing && listing.access === "write" && !listing.protectedReason;
  // While the next folder loads, keep the toolbar and path as they were (disabled), so nothing jumps.
  const lastWritable = React.useRef(false);
  const lastCrumbs = React.useRef<ListingT["breadcrumbs"]>([]);
  // The header describes the whole folder, even while a filter narrows the list.
  const unfiltered = React.useRef<{ path: string; counts: ListingT["counts"] } | null>(null);
  if (listing) {
    lastWritable.current = writable;
    lastCrumbs.current = listing.breadcrumbs;
    if (!filter) unfiltered.current = { path: listing.path, counts: listing.counts };
  }
  const showWrite = listing ? writable : lastWritable.current && !L.error;
  const measuring = useFolderSizes(view === "files" && !filter ? listing : undefined, () => void L.refresh());
  const clipboard = useClip();

  // ---- selection & dialogs
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState<string | null>(null);
  const [reveal, setReveal] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<FileEntry | null>(null);
  const [props, setProps] = React.useState<{ path: string; focus?: "apps" | "size" } | null>(null);
  const [ownershipPath, setOwnershipPath] = React.useState<string | null>(null);
  const [picker, setPicker] = React.useState<{ mode: "copy" | "move"; sources: string[] } | null>(null);
  const [railSheet, setRailSheet] = React.useState(false);
  const [keysOpen, setKeysOpen] = React.useState(false);
  const [railHidden, setRailHidden] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  /** A folder row under the pointer while files from the computer are dragged in (upload goes there). */
  const [dropInto, setDropInto] = React.useState<FileEntry | null>(null);
  const dropDepth = React.useRef(0);
  const [askConflicts, conflictNode] = useConflicts();
  const [confirm, confirmNode] = useConfirm();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const mainRef = React.useRef<HTMLDivElement>(null);
  const keepFocus = React.useRef(false);
  /** Going up a level lands on the folder you came from, like a desktop file manager. */
  const revealNext = React.useRef<string | null>(null);
  const lastFilesPath = React.useRef(path);
  if (view === "files") lastFilesPath.current = path;

  React.useEffect(() => {
    try {
      setRailHidden(localStorage.getItem("gluon.files.rail") === "hidden");
    } catch {
      /* private mode */
    }
  }, []);

  React.useEffect(() => {
    setSelected(new Set());
    setRenaming(null);
    setReveal(revealNext.current);
    revealNext.current = null;
    setDeepQuery(null);
    setFilterText("");
    setFilter("");
  }, [path, view]);

  React.useEffect(() => {
    if (listing && keepFocus.current) {
      keepFocus.current = false;
      mainRef.current?.querySelector<HTMLElement>("[role=grid]")?.focus({ preventScroll: true });
    }
  }, [listing?.path]);

  const navigate = React.useCallback(
    (p: string, v: Where["view"] = "files") => {
      const active = document.activeElement;
      keepFocus.current = !!active?.closest("[role=grid]") || active === document.body;
      const from = readLocation(defaultPath).path;
      revealNext.current = v === "files" && p !== from && from.startsWith(p === "/" ? "/" : `${p}/`) ? joinPath(p, from.slice(p === "/" ? 1 : p.length + 1).split("/")[0]!) : null;
      const url = v === "trash" ? "/files?view=trash" : filesHref(p);
      window.history.pushState(null, "", url);
      setRailSheet(false);
      window.scrollTo({ top: 0 });
    },
    [defaultPath],
  );

  const refreshAll = React.useCallback(() => {
    void L.refresh();
    void places.mutate();
  }, [L, places]);

  // ---- live jobs, upload completions, trash and size changes
  const mountedAt = React.useRef(Date.now());
  const [jobs, setJobs] = React.useState<Map<string, FileJob>>(new Map());
  const upsertJob = React.useCallback(
    (j: FileJob) =>
      setJobs((cur) => {
        const prev = cur.get(j.id);
        const next = new Map(cur);
        next.set(j.id, j);
        if (prev && (prev.status === "running" || prev.status === "queued") && j.status !== "running" && j.status !== "queued") {
          if (j.status === "done") toast.success(j.message ?? j.title);
          else if (j.status === "failed") toast.error(j.title, { description: j.error ?? j.message ?? undefined });
          setTimeout(() => {
            void L.refresh();
            void places.mutate();
            void trash.mutate();
          }, 50);
        }
        return next;
      }),
    [L, places, trash],
  );
  useStream("/api/files/jobs/stream", {
    snapshot: (d) => {
      const list = d as FileJob[];
      setJobs(new Map(list.filter((j) => j.status === "running" || j.status === "queued" || (j.finishedAt ?? 0) > mountedAt.current).map((j) => [j.id, j])));
    },
    job: (d) => upsertJob(d as FileJob),
    upload: (d) => {
      const u = d as UploadSession;
      if (u.status === "done" && u.dir === path) void L.refresh();
    },
    trash: () => void trash.mutate(),
  });
  React.useEffect(() => {
    void uploads.loadInterrupted();
    return uploads.onFinished((it) => {
      if (it.dir === readLocation(defaultPath).path) void L.refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.refresh]);

  const jobList = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);

  // ---- helpers
  const selectedEntries = React.useMemo(() => L.rows.filter((r): r is FileEntry => !!r && selected.has(r.path)), [L.rows, selected]);
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: e instanceof Error ? e.message : undefined });
  const nameOf = (entries: { name: string }[]) => (entries.length === 1 ? entries[0]!.name : fmt.plural(entries.length, "item"));

  async function download(entries: FileEntry[]) {
    if (!entries.length) return;
    if (entries.length === 1 && !isDirLike(entries[0]!)) return downloadUrl(rawUrl(entries[0]!.path, true));
    try {
      const est = await api.post<ZipEstimate>("/api/files/zip", { paths: entries.map((e) => e.path) });
      const go = () => downloadUrl(`/api/files/zip?token=${encodeURIComponent(est.token)}`);
      if (!est.warning) return go();
      confirm({
        title: `Download ${est.name}?`,
        description: est.warning,
        consequences: [`${fmt.plural(est.files, "file")} in ${fmt.plural(est.dirs, "folder")}, about ${fmt.bytes(est.bytes)} before zipping.`, "Photos, music and video are stored as they are, so the zip is about the same size.", "Keep this page open until the download starts."],
        confirmLabel: "Download zip",
        variant: "primary",
        onConfirm: go,
      });
    } catch (e) {
      fail("Couldn't prepare the download")(e);
    }
  }

  async function trashEntries(entries: FileEntry[]) {
    if (!entries.length) return;
    try {
      const r = await api.post<{ items: { id: string; name: string }[] }>("/api/files/trash", { paths: entries.map((e) => e.path) });
      setSelected(new Set());
      void L.refresh();
      const ids = r.items.map((i) => i.id);
      const t = toast.success(`Moved ${nameOf(r.items)} to the trash`, {
        action: {
          label: "Undo",
          onClick: () => {
            toast.dismiss(t);
            void api
              .post("/api/files/trash/restore", { ids, conflict: "rename" })
              .then(() => {
                void L.refresh();
                toast.success(`Put ${nameOf(r.items)} back`);
              })
              .catch(fail("Couldn't put it back"));
          },
        },
      });
    } catch (e) {
      fail("Couldn't move to the trash")(e);
    }
  }

  /** Move instant renames back where they came from (the undo on a move toast). */
  async function undoMove(moved: { from: string; to: string }[]) {
    try {
      const back = new Map<string, string[]>();
      for (const m of moved) back.set(parentOf(m.from), [...(back.get(parentOf(m.from)) ?? []), m.to]);
      for (const [dest, sources] of back) await api.post("/api/files/move", { sources, dest, conflict: "rename" });
      refreshAll();
      toast.success(moved.length === 1 ? `Moved ${baseName(moved[0]!.from)} back` : `Moved ${fmt.plural(moved.length, "item")} back`);
    } catch (e) {
      fail("Couldn't move it back")(e);
    }
  }

  /** Copy or move, asking about name clashes first. Resolves true when it went ahead. */
  async function transfer(sources: string[], dest: string, mode: "copy" | "move"): Promise<boolean> {
    try {
      const { conflicts } = await api.post<{ conflicts: { name: string; source: string; existing: FileEntry }[] }>("/api/files/conflicts", { sources, dest });
      const answers = await askConflicts(
        conflicts.map((c) => ({ name: c.name, isDir: isDirLike(c.existing), existing: c.existing })),
        dest,
        mode,
      );
      if (!answers) return false;
      const groups = new Map<"rename" | "overwrite", string[]>();
      for (const src of sources) {
        const pol = answers.get(baseName(src)) ?? "rename";
        if (pol === "skip") continue;
        groups.set(pol, [...(groups.get(pol) ?? []), src]);
      }
      if (!groups.size) {
        toast.info("Nothing to do — everything was skipped.");
        return false;
      }
      const moved: { from: string; to: string }[] = [];
      let started = false;
      for (const [conflict, list] of groups) {
        const r = await api.post<{ job: FileJob | null; moved?: { from: string; to: string }[]; skipped: string[] }>(`/api/files/${mode}`, { sources: list, dest, conflict });
        if (r.job) {
          upsertJob(r.job);
          started = true;
        }
        moved.push(...(r.moved ?? []));
      }
      setSelected(new Set());
      const where = dest === listing?.path ? "here" : `to ${baseName(dest) === "/" ? "Computer" : baseName(dest)}`;
      if (moved.length) {
        const t = toast.success(`Moved ${moved.length === 1 ? baseName(moved[0]!.to) : fmt.plural(moved.length, "item")} ${where}`, {
          action: {
            label: "Undo",
            onClick: () => {
              toast.dismiss(t);
              void undoMove(moved);
            },
          },
        });
      }
      else if (started) toast.info(`${mode === "copy" ? "Copying" : "Moving"} ${where}`, { description: "Progress is in the tasks tray; you can keep working." });
      void L.refresh();
      void places.mutate();
      return true;
    } catch (e) {
      fail(mode === "copy" ? "Couldn't copy" : "Couldn't move")(e);
      return false;
    }
  }
  const onDropItems = (sources: string[], dest: string, copy: boolean) => void transfer(sources, dest, copy ? "copy" : "move");

  // ---- the Files clipboard
  function clipboardOp(op: ClipOp, targets: FileEntry[] = selectedEntries) {
    if (!listing) return;
    if (op === "paste") return void paste(listing.path);
    if (!targets.length) return;
    if (op === "duplicate") return void transfer(targets.map((t) => t.path), listing.path, "copy");
    clip.set({ mode: op, paths: targets.map((t) => t.path), first: targets[0]!.name, from: listing.path });
    toast.info(op === "cut" ? `Cut ${nameOf(targets)}` : `Copied ${nameOf(targets)}`, { description: `Open another folder and paste with ${mod}V.`, timeout: 2600 });
  }

  async function paste(dest: string) {
    const c = clip.get();
    if (!c) return toast.info("Nothing to paste", { description: `Copy (${mod}C) or cut (${mod}X) something first.` });
    if (c.mode === "cut" && c.from === dest) {
      clip.set(null);
      return toast.info("They're already in this folder");
    }
    if (c.paths.some((p) => dest === p || dest.startsWith(`${p}/`))) return toast.error("A folder can't go inside itself", { description: "Open a different folder, then paste." });
    const ok = await transfer(c.paths, dest, c.mode === "cut" ? "move" : "copy");
    if (ok && c.mode === "cut") clip.set(null);
  }

  async function togglePin(e: { path: string; name: string; pinned: FileEntry["pinned"] }) {
    try {
      if (e.pinned) await api.del("/api/me/pins", { id: e.pinned.id });
      else await api.post("/api/me/pins", { kind: "folder", target: e.path, label: e.name.slice(0, 60) || e.path });
      void globalMutate("/api/shell");
      refreshAll();
      toast.success(e.pinned ? `Unpinned ${e.name}` : `Pinned ${e.name}`);
    } catch (err) {
      fail("Couldn't change the pin")(err);
    }
  }

  async function measure(target: { path: string; name: string }, all = false) {
    const t = toast.loading(all ? `Measuring the folders in ${target.name}…` : `Measuring ${target.name}…`);
    const url = `/api/files/size?path=${encodeURIComponent(target.path)}&refresh=1`;
    try {
      let r = await api.get<{ bytes: number | null; running: boolean; error: string | null; partial: boolean }>(url);
      for (let i = 0; r.running && i < 600; i++) {
        await new Promise((ok) => setTimeout(ok, 2500));
        r = await api.get(`/api/files/size?path=${encodeURIComponent(target.path)}`);
        if (i === 2 && r.running) void L.refresh();
      }
      void L.refresh();
      if (r.bytes === null) toast.update(t, "error", { title: `Couldn't measure ${target.name}`, description: r.error ?? undefined });
      else toast.update(t, "success", { title: `${target.name} uses ${fmt.bytes(r.bytes)}${r.partial ? " or more" : ""}` });
    } catch (e) {
      toast.update(t, "error", { title: `Couldn't measure ${target.name}`, description: e instanceof Error ? e.message : undefined });
    }
  }

  async function extract(e: FileEntry) {
    try {
      const r = await api.post<{ job: FileJob }>("/api/files/extract", { path: e.path });
      upsertJob(r.job);
      setPreview(null);
    } catch (err) {
      fail(`Couldn't extract ${e.name}`)(err);
    }
  }

  async function renameCommit(e: FileEntry, name: string) {
    setRenaming(null);
    setRenameDraft(null);
    try {
      const r = await api.post<FileEntry>("/api/files/rename", { path: e.path, name });
      await L.refresh();
      setReveal(r.path);
      setSelected(new Set([r.path]));
      if (e.pinned) void globalMutate("/api/shell");
      if (clip.get()?.paths.includes(e.path)) clip.set(null);
    } catch (err) {
      fail(`Couldn't rename ${e.name}`)(err);
      // Back into the field with what they typed, so they can fix it rather than start again.
      setRenameDraft(name);
      setRenaming(e.path);
    }
  }

  /**
   * New folder / new text file, made right away with a free name and then renamed in place (the
   * name is already selected, so typing replaces it; Esc keeps the suggested name).
   */
  async function createInline(kind: "folder" | "file") {
    if (!listing || !writable) return;
    if (filter || filterText) {
      setFilterText("");
      setFilter("");
    }
    const taken = new Set(L.rows.filter((r): r is FileEntry => !!r).map((r) => r.name.toLowerCase()));
    for (let i = 1; i < 60; i++) {
      const name = kind === "folder" ? (i === 1 ? "New folder" : `New folder ${i}`) : i === 1 ? "New text file.txt" : `New text file ${i}.txt`;
      if (taken.has(name.toLowerCase())) continue;
      try {
        const made =
          kind === "folder"
            ? await api.post<FileEntry>("/api/files/mkdir", { path: listing.path, name })
            : await api.put<{ path: string }>("/api/files/text", { path: joinPath(listing.path, name), content: "", expectedMtime: null, create: true });
        await L.refresh();
        setSelected(new Set([made.path]));
        setReveal(made.path);
        setRenaming(made.path);
        return;
      } catch (e) {
        if (e instanceof ApiError && e.code === "conflict") continue;
        return fail(kind === "folder" ? "Couldn't make a folder here" : "Couldn't make a file here")(e);
      }
    }
    toast.error("Couldn't find a free name", { description: "Rename some of the new folders here first." });
  }

  function open(e: FileEntry) {
    if (isDirLike(e)) {
      if (e.link?.outside) return toast.error(`${e.name} points outside your shared folders`);
      if (e.link?.broken) return toast.error(`${e.name} is a broken link`, { description: `It points to ${e.link.target}, which doesn't exist.` });
      navigate(e.path);
    } else if (e.link?.broken) {
      toast.error(`${e.name} is a broken link`, { description: `It points to ${e.link.target}, which doesn't exist.` });
    } else setPreview(e);
  }

  async function openHit(h: SearchHit) {
    if (h.type === "dir") return navigate(h.path);
    try {
      setPreview(await api.get<FileEntry>(`/api/files/stat?path=${encodeURIComponent(h.path)}`));
    } catch (e) {
      fail(`Couldn't open ${h.name}`)(e);
    }
  }

  // ---- uploads
  async function startUploads(incoming: { files: Incoming[]; dirs: string[] }, dest: string) {
    if (!incoming.files.length && !incoming.dirs.length) return;
    try {
      // Names already in the destination (top level only).
      let existing: FileEntry[];
      if (listing && dest === listing.path && !filter && prefs.filesShowHidden) existing = await L.loadAll();
      else existing = (await api.get<ListingT>(`/api/files/list?path=${encodeURIComponent(dest)}&hidden=1&limit=1000`)).entries;
      const byName = new Map(existing.map((e) => [e.name, e]));
      const tops = new Map<string, { isDir: boolean; size: number | null }>();
      for (const f of incoming.files) {
        const top = f.rel ? f.rel.split("/")[0]! : f.file.name;
        tops.set(top, { isDir: !!f.rel, size: f.rel ? null : f.file.size });
      }
      for (const d of incoming.dirs) if (!d.includes("/")) tops.set(d, { isDir: true, size: null });
      const clashes = [...tops.entries()].filter(([n]) => byName.has(n)).map(([n, t]) => ({ name: n, isDir: t.isDir, existing: byName.get(n)!, size: t.size }));
      const answers = await askConflicts(clashes, dest, "upload");
      if (!answers) return;

      // Folders: skip, merge (same name) or keep both (a free "Name (2)").
      const topRename = new Map<string, string>();
      for (const [n, t] of tops) {
        if (!t.isDir) continue;
        const a = answers.get(n);
        if (a === "skip") topRename.set(n, "");
        else if (a === "rename") {
          let i = 2;
          while (byName.has(`${n} (${i})`)) i++;
          topRename.set(n, `${n} (${i})`);
        } else topRename.set(n, n);
      }
      const mapRel = (rel: string) => {
        if (!rel) return rel;
        const [top, ...rest] = rel.split("/");
        const to = topRename.get(top!) ?? top!;
        return to ? [to, ...rest].join("/") : null;
      };
      const dirs = [...new Set(incoming.dirs.map(mapRel).filter((d): d is string => !!d))].sort((a, b) => a.split("/").length - b.split("/").length);
      for (const d of dirs) {
        const parent = d.includes("/") ? joinPath(dest, d.slice(0, d.lastIndexOf("/"))) : dest;
        try {
          await api.post("/api/files/mkdir", { path: parent, name: d.slice(d.lastIndexOf("/") + 1) });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "conflict")) throw e;
        }
      }
      const list = [];
      for (const f of incoming.files) {
        if (!f.rel) {
          const a = answers.get(f.file.name);
          if (a === "skip") continue;
          list.push({ file: f.file, dir: dest, conflict: a ?? "rename" });
        } else {
          const rel = mapRel(f.rel);
          if (rel === null) continue;
          const merged = topRename.get(f.rel.split("/")[0]!) === f.rel.split("/")[0];
          list.push({ file: f.file, dir: joinPath(dest, rel), conflict: merged ? ("overwrite" as const) : ("rename" as const) });
        }
      }
      if (dirs.length) void L.refresh();
      if (!list.length) return toast.info("Nothing to upload — everything was skipped.");
      uploads.enqueue(list);
      const bytes = list.reduce((a, x) => a + x.file.size, 0);
      toast.info(`Uploading ${fmt.plural(list.length, "file")} (${fmt.bytes(bytes)}) to ${baseName(dest) || "/"}`, { description: "Keep this tab open. If the connection drops, uploads continue where they stopped." });
    } catch (e) {
      fail("Couldn't start the upload")(e);
    }
  }

  // ---- menus
  const menuFor = (entries: FileEntry[]): MenuEntry[] => {
    const targets = entries.length === 1 && selected.has(entries[0]!.path) && selected.size > 1 ? selectedEntries : entries;
    const one = targets.length === 1 ? targets[0]! : null;
    const dir = one ? isDirLike(one) : false;
    const items: MenuEntry[] = [];
    if (one) items.push({ label: dir ? "Open" : one.preview ? "Preview" : "Open", icon: <OpenInWindow />, hint: dir ? "↵" : "Space", onSelect: () => open(one) });
    items.push({ label: targets.length > 1 || dir ? "Download as zip" : "Download", icon: <Download />, onSelect: () => void download(targets) });
    items.push("separator");
    if (writable && one) items.push({ label: "Rename", icon: <EditPencil />, hint: "F2", onSelect: () => setRenaming(one.path) });
    if (writable) items.push({ label: "Cut", icon: <Scissor />, hint: `${mod}X`, onSelect: () => clipboardOp("cut", targets) });
    items.push({ label: "Copy", icon: <Copy />, hint: `${mod}C`, onSelect: () => clipboardOp("copy", targets) });
    if (one && dir && writable && clipboard && !clipboard.paths.includes(one.path)) items.push({ label: `Paste into ${one.name}`, icon: <PasteClipboard />, onSelect: () => void paste(one.path) });
    if (writable) items.push({ label: "Duplicate", icon: <MultiplePages />, hint: `${mod}D`, onSelect: () => clipboardOp("duplicate", targets) });
    items.push({ label: "Copy to…", icon: <Copy />, onSelect: () => setPicker({ mode: "copy", sources: targets.map((t) => t.path) }) });
    if (writable) items.push({ label: "Move to…", icon: <DataTransferBoth />, onSelect: () => setPicker({ mode: "move", sources: targets.map((t) => t.path) }) });
    if (one && dir) {
      items.push("separator");
      items.push({ label: one.pinned ? "Unpin folder" : "Pin folder", icon: one.pinned ? <PinSlash /> : <Pin />, onSelect: () => void togglePin(one) });
      items.push({ label: one.dirSize ? "Measure again" : "Folder size", icon: <Refresh />, onSelect: () => void measure(one) });
      if (isAdmin) {
        items.push({ label: "Used by apps", onSelect: () => setProps({ path: one.path, focus: "apps" }) });
        items.push({ label: "Fix ownership for an app…", icon: <UserCrown />, onSelect: () => setOwnershipPath(one.path) });
      }
    }
    if (one && !dir && isArchive(one.name) && writable) items.push({ label: "Extract here", icon: <Archive />, onSelect: () => void extract(one) });
    if (one) {
      items.push("separator");
      items.push({ label: "Copy path", icon: <Copy />, onSelect: () => copyText(one.path) });
      items.push({ label: "Properties", icon: <InfoCircle />, onSelect: () => setProps({ path: one.path }) });
    }
    if (writable) {
      items.push("separator");
      items.push({ label: targets.length > 1 ? `Move ${targets.length} items to the trash` : "Move to the trash", icon: <Trash />, hint: "Del", danger: true, onSelect: () => void trashEntries(targets) });
    }
    return items;
  };

  const selectAll = async () => {
    const all = L.total > L.rows.filter(Boolean).length ? await L.loadAll(20_000) : L.rows.filter((r): r is FileEntry => !!r);
    setSelected(new Set(all.map((e) => e.path)));
    if (L.total > 20_000) toast.info(`Selected the first ${(20_000).toLocaleString()} items`);
  };

  const pasteLabel = clipboard ? `Paste ${clipboard.paths.length === 1 ? clipboard.first : fmt.plural(clipboard.paths.length, "item")}` : "Paste";
  const backgroundMenu: MenuEntry[] = [
    ...(writable
      ? ([
          { label: "New folder", icon: <FolderPlus />, hint: `${mod}⇧N`, onSelect: () => void createInline("folder") },
          { label: "New text file", icon: <PagePlus />, onSelect: () => void createInline("file") },
          { label: pasteLabel, icon: <PasteClipboard />, hint: `${mod}V`, disabled: !clipboard, onSelect: () => listing && void paste(listing.path) },
          "separator",
          { label: "Upload files…", icon: <Upload />, onSelect: () => fileInput.current?.click() },
          { label: "Upload a folder…", icon: <Upload />, onSelect: () => folderInput.current?.click() },
          "separator",
        ] as MenuEntry[])
      : []),
    { label: "Select all", hint: `${mod}A`, onSelect: () => void selectAll() },
    { kind: "check", label: "Show hidden files", checked: prefs.filesShowHidden, onChange: (v) => void setPrefs({ filesShowHidden: v }) },
    ...(listing ? ([{ label: "Measure folder sizes again", onSelect: () => void measure({ path: listing.path, name: listing.name }, true) }, { label: "Properties", icon: <InfoCircle />, onSelect: () => setProps({ path: listing.path }) }] as MenuEntry[]) : []),
  ];

  // Shortcuts that work anywhere on the page (not only with the list focused): Esc clears a
  // selection, ⌘V pastes, ⌘⇧N makes a folder. Never while typing, or with a dialog or menu open.
  const hasSelection = selected.size > 0;
  const keys = React.useRef({ createInline, paste, listing, writable, hasSelection });
  keys.current = { createInline, paste, listing, writable, hasSelection };
  React.useEffect(() => {
    if (view !== "files") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[role=dialog],[role=menu],[contenteditable]")) return;
      const k = keys.current;
      const m = e.metaKey || e.ctrlKey;
      const grid = mainRef.current?.querySelector<HTMLElement>("[role=grid]");
      // Nothing has focus (after a click on the page, a rename, or arriving in a folder): the list
      // takes the key, so arrows, F2, Delete, ⌘A, ⌘C and typing a name work without clicking first.
      const onControl = !!t?.closest("button,a,summary,[role=checkbox]");
      const free = !t || t === document.body || !t.closest(KEY_OWNERS);
      if (grid && free && e.key !== "Tab" && e.key !== "?" && !(m && e.shiftKey) && !(onControl && (e.key === "Enter" || e.key === " "))) {
        grid.focus({ preventScroll: true });
        const again = new KeyboardEvent("keydown", { key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, bubbles: true, cancelable: true });
        grid.dispatchEvent(again);
        if (again.defaultPrevented) e.preventDefault();
        return;
      }
      if (e.key === "Escape" && k.hasSelection) setSelected(new Set());
      else if (((e.altKey || m) && e.key === "ArrowUp") || (e.key === "Backspace" && !m && free)) {
        if (k.listing?.parent) navigate(k.listing.parent);
      } else if (m && !e.shiftKey && e.key.toLowerCase() === "v" && k.writable && k.listing && clip.get()) void k.paste(k.listing.path);
      else if (m && e.shiftKey && e.key.toLowerCase() === "n" && k.writable) void k.createInline("folder");
      else if (e.key === "?" && !m) setKeysOpen(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, navigate]);

  // ---- desktop drops: the whole folder is the target, or the sub-folder under the pointer
  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const folderUnder = (e: React.DragEvent): FileEntry | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    const row = el ? L.rows[Number(el.dataset.index)] : undefined;
    return row && isDirLike(row) && !row.link?.outside ? row : null;
  };
  const endDrop = () => {
    dropDepth.current = 0;
    setDropping(false);
    setDropInto(null);
  };
  const mainDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragHasFiles(e) || view !== "files") return;
      e.preventDefault();
      dropDepth.current++;
      setDropping(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragHasFiles(e) || view !== "files") return;
      e.preventDefault();
      e.dataTransfer.dropEffect = writable ? "copy" : "none";
      const f = writable ? folderUnder(e) : null;
      if ((f?.path ?? null) !== (dropInto?.path ?? null)) setDropInto(f);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (!dropDepth.current) endDrop();
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      const into = dropInto;
      endDrop();
      if (!writable || !listing) return;
      const dest = into?.path ?? listing.path;
      void readDrop(e.dataTransfer).then((r) => startUploads(r, dest), fail("Couldn't read what you dropped"));
    },
  };

  // ---- header: the folder's name (a drive or shared folder by its human name) and one sentence of state
  const pinned = listing?.self.pinned ?? null;
  const allPlaces = places.data?.places ?? [];
  const here = listing ? allPlaces.find((p) => p.path === listing.path) : undefined;
  const fsPlace = listing?.fs ? allPlaces.find((p) => (p.kind === "drive" || p.kind === "root") && p.path === listing.fs!.mount) : undefined;
  const friendly = here && here.label !== listing?.name ? here.label : null;
  let summary: React.ReactNode = null;
  if (view === "trash") {
    const t = trash.data;
    summary = t ? (t.items.length ? `${fmt.plural(t.items.length, "item")} using ${fmt.bytes(t.byFilesystem.reduce((a, f) => a + f.bytes, 0))}. Deleted things stay here until ${isAdmin ? "you empty the trash" : "an admin empties the trash"}.` : "Nothing in the trash.") : <SummarySkeleton />;
  } else if (listing) {
    const c = filter && unfiltered.current?.path === listing.path ? unfiltered.current.counts : listing.counts;
    const parts = [c.dirs ? fmt.plural(c.dirs, "folder") : null, c.files + c.links + c.other ? fmt.plural(c.files + c.links + c.other, "file") : null].filter(Boolean);
    // "on the 2.0 TB hard drive" reads better than a mount path, when the drive has a name of its own.
    const onDrive = fsPlace && fsPlace.path !== listing.path && fsPlace.kind === "drive" && fsPlace.label !== baseName(fsPlace.path) ? ` on the ${fsPlace.label}` : "";
    summary = (
      <span className="num">
        {parts.length ? parts.join(" and ") : c.hidden ? `Only ${fmt.plural(c.hidden, "hidden item")}` : "Empty"}
        {listing.self.dirSize && parts.length ? `, ${fmt.bytes(listing.self.dirSize.bytes)} in all` : ""}
.{" "}
        {listing.fs && (
          <>
            {fmt.bytes(listing.fs.avail)} free
            {!isAdmin ? "" : fsPlace && fsPlace.path === listing.path ? ` of ${fmt.bytes(listing.fs.size)}` : onDrive || (listing.fs.mount === "/" ? " on the system drive" : <> on <span className="mono">{listing.fs.mount}</span></>)}.{" "}
          </>
        )}
      </span>
    );
  } else if (L.error) summary = "This folder can't be shown.";
  else summary = <SummarySkeleton />;

  const titleText = view === "trash" ? "Trash" : (friendly ?? listing?.name ?? (L.error ? "Files" : baseName(path) === "/" ? "Computer" : baseName(path)));
  const title = (
    <span className={s.title} title={listing?.path ?? path}>
      {titleText}
    </span>
  );

  const rail = (
    <Rail
      places={places.data}
      current={listing?.path ?? path}
      trashOpen={view === "trash"}
      onNavigate={(p) => navigate(p)}
      onOpenTrash={() => navigate("", "trash")}
      onDropItems={onDropItems}
      onPinsChanged={() => {
        void places.mutate();
        void L.refresh();
        void globalMutate("/api/shell");
      }}
    />
  );

  const siblings = React.useMemo(() => L.rows.filter((r): r is FileEntry => !!r && !isDirLike(r) && !r.link?.broken), [L.rows]);
  const cutPaths = React.useMemo(() => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : null), [clipboard]);

  // A member nobody has shared a folder with has nothing to browse; say so plainly instead of an empty file manager.
  if (!isAdmin && places.data && places.data.places.length === 0 && places.data.pins.length === 0 && view === "files") {
    return (
      <Page narrow>
        <PageHeader title="Files" summary="Nothing has been shared with you yet." />
        <Empty title="No folders shared with you yet">
          When an admin shares a folder with you, like the family photos or the movie library, it shows up here and you can open, upload and download from any device.
        </Empty>
      </Page>
    );
  }

  const sortLabel = { name: "Name", mtime: "Modified", size: "Size", kind: "Kind", type: "Kind" }[sort];
  const sortMenu: MenuEntry[] = [
    { kind: "label", label: "Sort by" },
    ...(["name", "modified", "size", "kind"] as const).map((k) => ({
      kind: "check" as const,
      label: { name: "Name", modified: "Date modified", size: "Size", kind: "Kind" }[k],
      checked: prefs.filesSort === k,
      onChange: () => {
        setOrderOverride(null);
        void setPrefs({ filesSort: k });
      },
    })),
    "separator",
    { kind: "check", label: sort === "name" || sort === "kind" ? "A to Z" : sort === "size" ? "Smallest first" : "Oldest first", checked: order === "asc", onChange: () => setOrderOverride({ sort, order: "asc" }) },
    { kind: "check", label: sort === "name" || sort === "kind" ? "Z to A" : sort === "size" ? "Largest first" : "Newest first", checked: order === "desc", onChange: () => setOrderOverride({ sort, order: "desc" }) },
  ];

  return (
    <Page>
      <PageHeader
        title={title}
        summary={summary}
        actions={
          !phone && view === "files" && listing && listing.self.type !== "file" ? (
            <Button icon={pinned ? <PinSlash /> : <Pin />} onClick={() => void togglePin({ path: listing.path, name: friendly ?? listing.name, pinned })} aria-pressed={!!pinned}>
              {pinned ? "Unpin" : "Pin"}
            </Button>
          ) : undefined
        }
      />

      <div className={s.layout} data-rail={!phone && !railHidden ? "" : undefined} data-selecting={view === "files" && selected.size > 0 ? "" : undefined}>
        {!phone && !railHidden && <div className={s.rail}>{rail}</div>}

        <div className={s.main} ref={mainRef} {...mainDrop}>
          <div className={s.bar}>
            <IconButton
              label={phone ? "Show places" : railHidden ? "Show places" : "Hide places"}
              onClick={() => {
                if (phone) setRailSheet(true);
                else {
                  const next = !railHidden;
                  setRailHidden(next);
                  try {
                    localStorage.setItem("gluon.files.rail", next ? "hidden" : "shown");
                  } catch {
                    /* ignore */
                  }
                }
              }}
            >
              {phone || railHidden ? <SidebarExpand /> : <SidebarCollapse />}
            </IconButton>
            {view === "trash" ? (
              <Button variant="ghost" size="sm" icon={<NavArrowLeft />} onClick={() => navigate(lastFilesPath.current)}>
                Back to files
              </Button>
            ) : (
              <PathBar
                crumbs={listing?.breadcrumbs ?? guessCrumbs(lastCrumbs.current, path)}
                path={listing?.path ?? path}
                places={isAdmin ? allPlaces : undefined}
                compact={phone}
                hidden={prefs.filesShowHidden}
                canDrop
                onNavigate={(p) => navigate(p)}
                onDropItems={onDropItems}
              />
            )}
          </div>

          {view === "files" && (
            <div className={s.toolbar}>
              <form
                className={s.filter}
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (filterText.trim()) setDeepQuery(filterText.trim());
                }}
              >
                <Search aria-hidden />
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && filterText) {
                      e.preventDefault();
                      setFilterText("");
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      mainRef.current?.querySelector<HTMLElement>("[role=grid]")?.focus();
                    }
                  }}
                  placeholder={phone ? "Filter" : "Filter this folder"}
                  aria-label="Filter this folder, or press Enter to search every folder inside"
                  spellCheck={false}
                  enterKeyHint="search"
                />
                {filterText ? (
                  <button type="button" className={s.filterClear} onClick={() => setFilterText("")} aria-label="Clear the filter">
                    <Xmark />
                  </button>
                ) : (
                  !phone && <span className={s.filterHint} aria-hidden>↵ searches inside</span>
                )}
              </form>
              <span className={s.spacer} />
              <div className={s.viewGroup} role="group" aria-label="How to show this folder">
                <Segmented
                  aria-label="View"
                  value={prefs.filesView}
                  onChange={(v) => void setPrefs({ filesView: v })}
                  options={[
                    { value: "list", label: null, icon: <List />, ariaLabel: "List" },
                    { value: "grid", label: null, icon: <ViewGrid />, ariaLabel: "Grid" },
                  ]}
                />
                <Menu
                  trigger={
                    <Button variant="ghost" icon={order === "asc" ? <SortUp /> : <SortDown />} aria-label={`Sorted by ${sortLabel.toLowerCase()}, ${order === "asc" ? "ascending" : "descending"}. Change sorting`}>
                      <span className={s.sortText}>{sortLabel}</span>
                    </Button>
                  }
                  items={sortMenu}
                />
              </div>
              <Menu
                trigger={
                  <IconButton label="More">
                    <MoreHoriz />
                  </IconButton>
                }
                items={[
                  ...(phone && listing && listing.self.type !== "file" ? ([{ label: pinned ? "Unpin this folder" : "Pin this folder", icon: pinned ? <PinSlash /> : <Pin />, onSelect: () => void togglePin({ path: listing.path, name: friendly ?? listing.name, pinned }) }] as MenuEntry[]) : []),
                  ...(writable
                    ? ([
                        { label: "New text file", icon: <PagePlus />, onSelect: () => void createInline("file") },
                        ...(clipboard ? [{ label: pasteLabel, icon: <PasteClipboard />, hint: `${mod}V`, onSelect: () => listing && void paste(listing.path) }] : []),
                        { label: "Upload a whole folder…", icon: <Upload />, onSelect: () => folderInput.current?.click() },
                        "separator",
                      ] as MenuEntry[])
                    : []),
                  { label: prefs.filesShowHidden ? "Hide hidden files" : "Show hidden files", icon: prefs.filesShowHidden ? <EyeClosed /> : <Eye />, onSelect: () => void setPrefs({ filesShowHidden: !prefs.filesShowHidden }) },
                  ...(listing ? ([{ label: "Measure folder sizes again", icon: <Refresh />, onSelect: () => void measure({ path: listing.path, name: listing.name }, true) }] as MenuEntry[]) : []),
                  { label: "Select all", hint: `${mod}A`, onSelect: () => void selectAll() },
                  "separator",
                  ...(listing ? ([{ label: "Copy path", icon: <Copy />, onSelect: () => copyText(listing.path) }, { label: "Properties", icon: <InfoCircle />, onSelect: () => setProps({ path: listing.path }) }] as MenuEntry[]) : []),
                  ...(isAdmin && listing ? ([{ label: "Used by apps", onSelect: () => setProps({ path: listing.path, focus: "apps" }) }] as MenuEntry[]) : []),
                  { label: "Trash", icon: <Trash />, onSelect: () => navigate("", "trash") },
                  ...(touch ? [] : (["separator", { label: "Keyboard shortcuts", hint: "?", onSelect: () => setKeysOpen(true) }] as MenuEntry[])),
                ]}
              />
              {showWrite && (
                <>
                  <IconButton label="New folder" shortcut={`${mod}⇧N`} disabled={!writable} onClick={() => void createInline("folder")}>
                    <FolderPlus />
                  </IconButton>
                  <Button icon={<Upload />} variant="primary" disabled={!writable} onClick={() => fileInput.current?.click()}>
                    Upload
                  </Button>
                </>
              )}
            </div>
          )}

          {view === "trash" ? (
            <TrashView data={trash.data} error={trash.error} isAdmin={isAdmin} refresh={() => void trash.mutate()} onJob={upsertJob} onNavigate={(p) => navigate(p)} />
          ) : deepQuery && listing ? (
            <SearchResults root={listing.path} q={deepQuery} onOpen={(h) => void openHit(h)} onClose={() => setDeepQuery(null)} />
          ) : (
            <FolderBody
              L={L}
              path={path}
              writable={writable}
              filter={filter}
              view={prefs.filesView}
              showOwner={isAdmin}
              onNavigate={navigate}
              onUpload={() => fileInput.current?.click()}
              onNewFolder={() => void createInline("folder")}
              onDeepSearch={() => setDeepQuery(filter)}
              onShowHidden={() => void setPrefs({ filesShowHidden: true })}
              paste={clipboard && writable && listing && clipboard.from !== listing.path ? { label: pasteLabel, run: () => void paste(listing.path) } : null}
              firstPlace={places.data?.places[0]?.path ?? null}
            >
              {listing && (
                <Listing
                  key={listing.path}
                  rows={L.rows}
                  total={L.total}
                  ensure={L.ensure}
                  view={prefs.filesView}
                  sort={sort}
                  order={order}
                  onSort={(k) => {
                    if (k === sort) setOrderOverride({ sort, order: order === "asc" ? "desc" : "asc" });
                    else {
                      setOrderOverride(null);
                      void setPrefs({ filesSort: prefFromSort(k) });
                    }
                  }}
                  selected={selected}
                  setSelected={setSelected}
                  writable={writable}
                  renaming={renaming}
                  renameDraft={renameDraft}
                  reveal={reveal}
                  onOpen={open}
                  onPreview={(e) => (e.link?.broken ? open(e) : setPreview(e))}
                  onUp={() => listing.parent && navigate(listing.parent)}
                  onTrash={(es) => void trashEntries(es)}
                  onRename={(e) => setRenaming(e.path)}
                  onRenameCommit={(e, n) => void renameCommit(e, n)}
                  onRenameCancel={() => {
                    setRenaming(null);
                    setRenameDraft(null);
                  }}
                  onCalculate={(e) => void measure(e)}
                  onDropItems={onDropItems}
                  menuFor={menuFor}
                  backgroundMenu={backgroundMenu}
                  onSelectAll={() => void selectAll()}
                  onClipboard={(op) => clipboardOp(op)}
                  dropPath={dropInto?.path ?? null}
                  showOwner={isAdmin}
                  measuring={measuring}
                  cutPaths={cutPaths}
                  touch={touch}
                />
              )}
            </FolderBody>
          )}

          {dropping && (
            <div className={s.dropZone} data-refused={writable ? undefined : ""} data-into={dropInto ? "" : undefined} aria-hidden>
              <div className={s.dropNote}>
                <Upload />
                <span>
                  {!writable ? (
                    (listing?.protectedReason ?? "You can't upload into this folder.")
                  ) : (
                    <>
                      Drop to upload into <b>{dropInto?.name ?? friendly ?? listing?.name}</b>
                      {listing?.fs && <span className={`${s.dropFree} num`}>{fmt.bytes(listing.fs.avail)} free</span>}
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          {view === "files" && selected.size > 0 && (
            <SelectionBar
              entries={selectedEntries}
              count={selected.size}
              writable={writable}
              phone={phone}
              onDownload={() => void download(selectedEntries)}
              onCopy={() => setPicker({ mode: "copy", sources: [...selected] })}
              onMove={() => setPicker({ mode: "move", sources: [...selected] })}
              onTrash={() => void trashEntries(selectedEntries)}
              onClear={() => setSelected(new Set())}
              menu={menuFor(selectedEntries)}
            />
          )}
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].map((f) => ({ file: f, rel: "" }));
          e.target.value = "";
          if (listing) void startUploads({ files, dirs: [] }, listing.path);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => {
          const r = fromInput(e.target.files);
          e.target.value = "";
          if (listing) void startUploads(r, listing.path);
        }}
      />

      {phone && (
        <Dialog open={railSheet} onOpenChange={setRailSheet} title="Places">
          {rail}
        </Dialog>
      )}

      <Preview entry={preview} siblings={siblings} onNavigate={setPreview} onClose={() => setPreview(null)} canWrite={writable} onExtract={(e) => void extract(e)} onSaved={() => void L.refresh()} />
      <Properties
        path={props?.path ?? null}
        focus={props?.focus}
        onClose={() => setProps(null)}
        onFixOwnership={
          isAdmin
            ? (p) => {
                setProps(null);
                setOwnershipPath(p);
              }
            : undefined
        }
      />
      {isAdmin && <Ownership path={ownershipPath} onClose={() => setOwnershipPath(null)} onStarted={upsertJob} />}
      <FolderPicker
        open={!!picker}
        onOpenChange={(o) => !o && setPicker(null)}
        title={picker?.mode === "move" ? `Move ${fmt.plural(picker?.sources.length ?? 0, "item")} to…` : `Copy ${fmt.plural(picker?.sources.length ?? 0, "item")} to…`}
        confirmLabel={(n) => `${picker?.mode === "move" ? "Move" : "Copy"} to ${n}`}
        initialPath={listing?.path ?? path}
        places={places.data}
        onPick={(dest) => picker && void transfer(picker.sources, dest, picker.mode)}
      />
      <Tray
        jobs={jobList}
        onClearJobs={() => setJobs((cur) => new Map([...cur].filter(([, j]) => j.status === "running" || j.status === "queued")))}
        onCancelJob={(id) => void api.del(`/api/files/jobs/${id}`).catch(fail("Couldn't stop the task"))}
        onUndo={(j) =>
          void api
            .post<{ job: FileJob }>("/api/files/ownership/undo", { jobId: j.result?.undo })
            .then((r) => upsertJob(r.job))
            .catch(fail("Couldn't undo"))
        }
      />
      <Shortcuts open={keysOpen} onClose={() => setKeysOpen(false)} mod={mod} />
      {conflictNode}
      {confirmNode}
    </Page>
  );
}

/** Breadcrumbs for a folder that's still loading, from the last ones shown (so the bar doesn't flash). */
function guessCrumbs(prev: ListingT["breadcrumbs"], path: string): ListingT["breadcrumbs"] {
  const within = (c: { path: string }) => c.path === path || c.path === "/" || path.startsWith(`${c.path}/`);
  const kept = prev.filter(within);
  if (!kept.length) return [{ name: baseName(path) === "/" ? "Computer" : baseName(path), path }];
  const last = kept[kept.length - 1]!;
  const rest = last.path === path ? [] : path.slice(last.path === "/" ? 1 : last.path.length + 1).split("/").filter(Boolean);
  let acc = last.path;
  return [...kept, ...rest.map((name) => ({ name, path: (acc = joinPath(acc, name)) }))];
}

function SummarySkeleton() {
  return (
    <span className={s.summarySkeleton} aria-label="Loading">
      <Skeleton width={260} height={12} />
    </span>
  );
}

/**
 * What's selected and what you can do with it. Floats over the bottom of the list on a computer;
 * on a phone it becomes a toolbar along the bottom edge with labels under the icons.
 */
function SelectionBar({
  entries,
  count,
  writable,
  phone,
  onDownload,
  onCopy,
  onMove,
  onTrash,
  onClear,
  menu,
}: {
  entries: FileEntry[];
  count: number;
  writable: boolean;
  phone: boolean;
  onDownload: () => void;
  onCopy: () => void;
  onMove: () => void;
  onTrash: () => void;
  onClear: () => void;
  menu: MenuEntry[];
}) {
  const fmt = useFormat();
  let bytes = 0;
  let unknown = 0;
  for (const e of entries) {
    if (isDirLike(e)) {
      if (e.dirSize) bytes += e.dirSize.bytes;
      else unknown++;
    } else bytes += e.size ?? 0;
  }
  const size = unknown === entries.length ? null : `${unknown ? "at least " : ""}${fmt.bytes(bytes)}`;
  const label = `${fmt.plural(count, "item")} selected${size ? `, ${size}` : ""}`;

  if (phone) {
    return (
      <div className={s.phoneBar} role="toolbar" aria-label={label}>
        <div className={s.phoneBarHead}>
          <span className="num">
            <b>{fmt.plural(count, "item")}</b>
            {size && <span className="muted"> · {size}</span>}
          </span>
          <button type="button" className={s.phoneBarDone} onClick={onClear}>
            Done
          </button>
        </div>
        <div className={s.phoneBarActions}>
          <PhoneAction icon={<Download />} label="Download" onClick={onDownload} />
          {writable ? <PhoneAction icon={<DataTransferBoth />} label="Move" onClick={onMove} /> : <PhoneAction icon={<Copy />} label="Copy" onClick={onCopy} />}
          {writable && <PhoneAction icon={<Trash />} label="Trash" onClick={onTrash} />}
          <Menu side="top" trigger={<button type="button" className={s.phoneAction}><MoreHoriz /><span>More</span></button>} items={menu} />
        </div>
      </div>
    );
  }

  return (
    <div className={s.floatBar} role="toolbar" aria-label={label}>
      <span className={`${s.floatCount} num`}>
        {fmt.plural(count, "item")}
        {size && <span className={s.floatSize}>{size}</span>}
      </span>
      <span className={s.floatRule} aria-hidden />
      <Button size="sm" variant="ghost" icon={<Download />} onClick={onDownload}>
        Download
      </Button>
      <Button size="sm" variant="ghost" icon={<Copy />} onClick={onCopy}>
        Copy to…
      </Button>
      {writable && (
        <>
          <Button size="sm" variant="ghost" icon={<DataTransferBoth />} onClick={onMove}>
            Move to…
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash />} onClick={onTrash}>
            Trash
          </Button>
        </>
      )}
      <span className={s.floatRule} aria-hidden />
      <IconButton label="Clear selection" size="sm" shortcut="Esc" onClick={onClear}>
        <Xmark />
      </IconButton>
    </div>
  );
}

function PhoneAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className={s.phoneAction} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FolderBody({
  L,
  path,
  writable,
  filter,
  view,
  showOwner,
  onNavigate,
  onUpload,
  onNewFolder,
  onDeepSearch,
  onShowHidden,
  paste,
  firstPlace,
  children,
}: {
  L: ReturnType<typeof useListing>;
  path: string;
  writable: boolean;
  filter: string;
  view: "list" | "grid";
  showOwner: boolean;
  onNavigate: (p: string) => void;
  onUpload: () => void;
  onNewFolder: () => void;
  onDeepSearch: () => void;
  onShowHidden: () => void;
  /** Something is on the Files clipboard: an empty folder offers to paste it. */
  paste: { label: string; run: () => void } | null;
  firstPlace: string | null;
  children: React.ReactNode;
}) {
  const fmt = useFormat();
  const { listing, error } = L;
  if (error) {
    if (error.code === "not_found") {
      return (
        <Notice title="This folder isn't there any more" action={path !== "/" ? <Button size="sm" onClick={() => onNavigate(parentOf(path))}>Go up a level</Button> : undefined}>
          <span className="mono">{path}</span> may have been moved, renamed or deleted, or the drive it's on isn't mounted.
        </Notice>
      );
    }
    if (error.code === "forbidden" || error.code === "in_trash") {
      return (
        <Notice title="You can't open this folder" action={firstPlace ? <Button size="sm" onClick={() => onNavigate(firstPlace)}>Go to your folders</Button> : undefined}>
          {error.message}
        </Notice>
      );
    }
    if (error.code === "not_a_folder") {
      return (
        <Notice title="That's a file, not a folder" action={<Button size="sm" onClick={() => onNavigate(parentOf(path))}>Open the folder it's in</Button>}>
          <span className="mono">{path}</span>
        </Notice>
      );
    }
    return (
      <Notice tone="fault" title={error.code === "network" ? "Can't reach the server" : "This folder couldn't be listed"} action={<Button size="sm" onClick={() => void L.refresh()}>Try again</Button>}>
        {error.message}
      </Notice>
    );
  }
  if (!listing) return <ListingSkeleton view={view} showOwner={showOwner} />;
  const notices: React.ReactNode[] = [];
  if (listing.access === "read") notices.push(<Notice key="ro" title="View only">This folder is shared with you to view. You can open and download files here, but not change them.</Notice>);
  else if (listing.protectedReason) notices.push(<Notice key="prot" title="View only here">{listing.protectedReason}</Notice>);
  if (listing.sortLimited) notices.push(<Notice key="big">This folder has {listing.total.toLocaleString()} items, so it's sorted by name. Sorting by size or date works in folders with fewer than 20,000 items.</Notice>);
  if (listing.truncated) notices.push(<Notice key="trunc" tone="attention" title="Only part of this folder is listed">It holds more than {(250_000).toLocaleString()} items; the first ones are shown. Use search to find the rest.</Notice>);

  let content: React.ReactNode = children;
  if (listing.total === 0) {
    if (filter) {
      content = (
        <Empty title={`Nothing here matches “${filter}”`} action={<Button onClick={onDeepSearch} icon={<Search />}>Search every folder inside</Button>}>
          The filter only looks at this folder. Search also looks inside every folder in it.
        </Empty>
      );
    } else if (writable) {
      content = (
        <Empty
          title={listing.counts.hidden > 0 ? "Only hidden items here" : "This folder is empty"}
          action={
            <>
              <Button variant="primary" icon={<Upload />} onClick={onUpload}>
                Upload files
              </Button>
              <Button icon={<FolderPlus />} onClick={onNewFolder}>
                New folder
              </Button>
              {paste && (
                <Button icon={<PasteClipboard />} onClick={paste.run}>
                  {paste.label}
                </Button>
              )}
              {listing.counts.hidden > 0 && (
                <Button variant="ghost" icon={<Eye />} onClick={onShowHidden}>
                  Show {fmt.plural(listing.counts.hidden, "hidden item")}
                </Button>
              )}
            </>
          }
        >
          Drag files or whole folders here from your computer to upload them. Big uploads carry on where they stopped if the connection drops.
        </Empty>
      );
    } else {
      content = (
        <Empty
          title={listing.counts.hidden > 0 ? "Only hidden items here" : "This folder is empty"}
          action={
            listing.counts.hidden > 0 ? (
              <Button icon={<Eye />} onClick={onShowHidden}>
                Show {fmt.plural(listing.counts.hidden, "hidden item")}
              </Button>
            ) : undefined
          }
        >
          {listing.counts.hidden > 0 ? "It only has hidden items, like settings files." : "Nothing has been put here yet."}
        </Empty>
      );
    }
  }
  return (
    <>
      {notices.length > 0 && <div className={s.notices}>{notices}</div>}
      {content}
    </>
  );
}
