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
} from "iconoir-react";
import type { FileEntry, FileJob, Listing as ListingT, Places, SearchHit, TrashSummary, UploadSession, ZipEstimate } from "@/lib/files-types";
import { api, ApiError, useApi, useStream } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented, Field, Input } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { useListing } from "./useListing";
import { Listing } from "./Listing";
import { Rail } from "./Rail";
import { PathBar } from "./PathBar";
import { Preview } from "./Preview";
import { Properties, copyText } from "./Properties";
import { Ownership } from "./Ownership";
import { FolderPicker } from "./FolderPicker";
import { Tray } from "./Tray";
import { TrashView } from "./TrashView";
import { SearchResults } from "./SearchResults";
import { useConflicts } from "./Conflicts";
import { uploads } from "./uploads";
import { readDrop, fromInput, type Incoming } from "./drop";
import { baseName, downloadUrl, filesHref, isArchive, isDirLike, joinPath, parentOf, prefFromSort, rawUrl, sortFromPref, useMediaQuery } from "./lib";
import s from "./files.module.css";

type Where = { path: string; view: "files" | "trash" };

function readLocation(fallback: string): Where {
  if (typeof window === "undefined") return { path: fallback, view: "files" };
  const q = new URLSearchParams(window.location.search);
  return { path: q.get("path") || fallback, view: q.get("view") === "trash" ? "trash" : "files" };
}

export function FilesView({ initialPlaces, defaultPath }: { initialPlaces: Places | null; defaultPath: string }) {
  const fmt = useFormat();
  const { prefs, setPrefs, viewer } = usePrefs();
  const isAdmin = viewer.role === "admin";
  const search = useSearchParams();
  const path = search.get("path") || defaultPath;
  const view: Where["view"] = search.get("view") === "trash" ? "trash" : "files";
  const phone = useMediaQuery("(max-width: 900px)");

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

  // ---- selection & dialogs
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [reveal, setReveal] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<FileEntry | null>(null);
  const [props, setProps] = React.useState<{ path: string; focus?: "apps" | "size" } | null>(null);
  const [ownershipPath, setOwnershipPath] = React.useState<string | null>(null);
  const [picker, setPicker] = React.useState<{ mode: "copy" | "move"; sources: string[] } | null>(null);
  const [newFolder, setNewFolder] = React.useState(false);
  const [railSheet, setRailSheet] = React.useState(false);
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

  const navigate = React.useCallback((p: string, v: Where["view"] = "files") => {
    keepFocus.current = !!document.activeElement?.closest("[role=grid]");
    const url = v === "trash" ? "/files?view=trash" : filesHref(p);
    window.history.pushState(null, "", url);
    setRailSheet(false);
    window.scrollTo({ top: 0 });
  }, []);

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

  // Esc clears a selection from anywhere on the page (the floating bar says so), unless a dialog or field has it.
  const hasSelection = selected.size > 0;
  React.useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[role=dialog],[role=menu],[contenteditable]")) return;
      setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection]);

  // ---- helpers
  const selectedEntries = React.useMemo(() => L.rows.filter((r): r is FileEntry => !!r && selected.has(r.path)), [L.rows, selected]);
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: e instanceof Error ? e.message : undefined });

  async function download(entries: FileEntry[]) {
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
      toast.success(r.items.length === 1 ? `Moved ${r.items[0]!.name} to the trash` : `Moved ${fmt.plural(r.items.length, "item")} to the trash`, {
        action: {
          label: "Undo",
          onClick: () =>
            void api
              .post("/api/files/trash/restore", { ids, conflict: "rename" })
              .then(() => void L.refresh())
              .catch(fail("Couldn't put it back")),
        },
      });
    } catch (e) {
      fail("Couldn't move to the trash")(e);
    }
  }

  async function transfer(sources: string[], dest: string, mode: "copy" | "move") {
    try {
      const { conflicts } = await api.post<{ conflicts: { name: string; source: string; existing: FileEntry }[] }>("/api/files/conflicts", { sources, dest });
      const answers = await askConflicts(
        conflicts.map((c) => ({ name: c.name, isDir: isDirLike(c.existing), existing: c.existing })),
        dest,
        mode,
      );
      if (!answers) return;
      const groups = new Map<"rename" | "overwrite", string[]>();
      for (const src of sources) {
        const pol = answers.get(baseName(src)) ?? "rename";
        if (pol === "skip") continue;
        groups.set(pol, [...(groups.get(pol) ?? []), src]);
      }
      if (!groups.size) return toast.info("Nothing to do — everything was skipped.");
      let moved = 0;
      for (const [conflict, list] of groups) {
        const r = await api.post<{ job: FileJob | null; moved?: unknown[]; skipped: string[] }>(`/api/files/${mode}`, { sources: list, dest, conflict });
        if (r.job) upsertJob(r.job);
        moved += r.moved?.length ?? 0;
      }
      setSelected(new Set());
      if (moved) toast.success(`Moved ${fmt.plural(moved, "item")} to ${baseName(dest) || "/"}`, { action: { label: "Show", onClick: () => navigate(dest) } });
      else toast.info(`${mode === "copy" ? "Copying" : "Moving"} in the background`, { description: "Progress is in the tasks tray." });
      void L.refresh();
      void places.mutate();
    } catch (e) {
      fail(mode === "copy" ? "Couldn't copy" : "Couldn't move")(e);
    }
  }
  const onDropItems = (sources: string[], dest: string, copy: boolean) => void transfer(sources, dest, copy ? "copy" : "move");

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
    try {
      const r = await api.post<FileEntry>("/api/files/rename", { path: e.path, name });
      await L.refresh();
      setReveal(r.path);
      setSelected(new Set([r.path]));
      if (e.pinned) void globalMutate("/api/shell");
    } catch (err) {
      fail(`Couldn't rename ${e.name}`)(err);
    }
  }

  function open(e: FileEntry) {
    if (isDirLike(e)) {
      if (e.link?.outside) return toast.error(`${e.name} points outside your shared folders`);
      if (e.link?.broken) return toast.error(`${e.name} is a broken link`, { description: `It points to ${e.link.target}, which doesn't exist.` });
      navigate(e.path);
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
    if (one) items.push({ label: dir ? "Open" : one.preview ? "Preview" : "Open", icon: <OpenInWindow />, hint: "↵", onSelect: () => open(one) });
    items.push({ label: targets.length > 1 || dir ? "Download as zip" : "Download", icon: <Download />, onSelect: () => void download(targets) });
    items.push("separator");
    if (writable && one) items.push({ label: "Rename", icon: <EditPencil />, hint: "F2", onSelect: () => setRenaming(one.path) });
    items.push({ label: "Copy to…", icon: <Copy />, onSelect: () => setPicker({ mode: "copy", sources: targets.map((t) => t.path) }) });
    if (writable) items.push({ label: "Move to…", icon: <DataTransferBoth />, onSelect: () => setPicker({ mode: "move", sources: targets.map((t) => t.path) }) });
    if (one && dir) {
      items.push("separator");
      items.push({ label: one.pinned ? "Unpin folder" : "Pin folder", icon: one.pinned ? <PinSlash /> : <Pin />, onSelect: () => void togglePin(one) });
      items.push({ label: "Folder size", onSelect: () => void measure(one) });
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
      items.push({ label: targets.length > 1 ? `Move ${targets.length} items to trash` : "Move to trash", icon: <Trash />, hint: "Del", danger: true, onSelect: () => void trashEntries(targets) });
    }
    return items;
  };

  const selectAll = async () => {
    const all = L.total > L.rows.filter(Boolean).length ? await L.loadAll(20_000) : L.rows.filter((r): r is FileEntry => !!r);
    setSelected(new Set(all.map((e) => e.path)));
    if (L.total > 20_000) toast.info(`Selected the first ${(20_000).toLocaleString()} items`);
  };

  const backgroundMenu: MenuEntry[] = [
    ...(writable
      ? ([
          { label: "New folder", icon: <FolderPlus />, onSelect: () => setNewFolder(true) },
          { label: "Upload files…", icon: <Upload />, onSelect: () => fileInput.current?.click() },
          { label: "Upload a folder…", icon: <Upload />, onSelect: () => folderInput.current?.click() },
          "separator",
        ] as MenuEntry[])
      : []),
    { label: "Select all", hint: "⌘A", onSelect: () => void selectAll() },
    { kind: "check", label: "Show hidden files", checked: prefs.filesShowHidden, onChange: (v) => void setPrefs({ filesShowHidden: v }) },
    ...(listing ? ([{ label: "Calculate folder sizes", onSelect: () => void measure({ path: listing.path, name: listing.name }, true) }, { label: "Properties", icon: <InfoCircle />, onSelect: () => setProps({ path: listing.path }) }] as MenuEntry[]) : []),
  ];

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

  // ---- header: a drive or shared folder is called by its human name, with its path underneath
  const pinned = listing?.self.pinned ?? null;
  const allPlaces = places.data?.places ?? [];
  const here = listing ? allPlaces.find((p) => p.path === listing.path) : undefined;
  const fsPlace = listing?.fs ? allPlaces.find((p) => (p.kind === "drive" || p.kind === "root") && p.path === listing.fs!.mount) : undefined;
  const friendly = here && here.label !== listing?.name ? here.label : null;
  let summary: React.ReactNode = null;
  if (view === "trash") {
    const t = trash.data;
    summary = t ? (t.items.length ? `${fmt.plural(t.items.length, "item")} using ${fmt.bytes(t.byFilesystem.reduce((a, f) => a + f.bytes, 0))}. Deleted things stay here until ${isAdmin ? "you empty the trash" : "an admin empties the trash"}.` : "Nothing in the trash.") : "Loading…";
  } else if (listing) {
    const c = listing.counts;
    const parts = [c.dirs ? fmt.plural(c.dirs, "folder") : null, c.files + c.links + c.other ? fmt.plural(c.files + c.links + c.other, "file") : null].filter(Boolean);
    // "on the 2.0 TB hard drive" reads better than a mount path, when the drive has a name of its own.
    const onDrive = fsPlace && fsPlace.path !== listing.path && fsPlace.kind === "drive" && fsPlace.label !== baseName(fsPlace.path) ? ` on the ${fsPlace.label}` : "";
    summary = (
      <>
        {parts.length ? parts.join(" and ") : "Empty"}
        {listing.self.dirSize ? `, ${fmt.bytes(listing.self.dirSize.bytes)} in total` : ""}.{" "}
        {listing.fs && (
          <span className="num">
            {fmt.bytes(listing.fs.avail)} free
            {!isAdmin ? "" : fsPlace && fsPlace.path === listing.path ? ` of ${fmt.bytes(listing.fs.size)}` : onDrive || (listing.fs.mount === "/" ? " on the system drive" : <> on <span className="mono">{listing.fs.mount}</span></>)}.
          </span>
        )}{" "}
        {listing.access === "read" ? "Shared with you to view." : listing.protectedReason ? "View only." : ""}
      </>
    );
  } else if (L.error) summary = "This folder can't be shown.";

  const titleText = view === "trash" ? "Trash" : (friendly ?? listing?.name ?? (L.error ? "Files" : baseName(path) || "Computer"));
  const title =
    friendly && listing ? (
      <span className={s.titleBlock}>
        {friendly}
        <span className={`${s.titlePath} mono`} title={listing.path}>
          {listing.path}
        </span>
      </span>
    ) : (
      titleText
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

  const siblings = React.useMemo(() => L.rows.filter((r): r is FileEntry => !!r && !isDirLike(r)), [L.rows]);

  // A member nobody has shared a folder with has nothing to browse; say so plainly instead of an empty file manager.
  if (!isAdmin && places.data && places.data.places.length === 0 && places.data.pins.length === 0 && view === "files") {
    return (
      <Page narrow>
        <PageHeader title="Files" />
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
              <PathBar crumbs={listing?.breadcrumbs ?? [{ name: baseName(path) || "Computer", path }]} path={listing?.path ?? path} canDrop onNavigate={(p) => navigate(p)} onDropItems={onDropItems} />
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
                <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder={phone ? "Filter" : "Filter this folder"} aria-label="Filter this folder, or press Enter to search every folder inside" spellCheck={false} enterKeyHint="search" />
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
                  ...(writable ? ([{ label: "Upload a whole folder…", icon: <Upload />, onSelect: () => folderInput.current?.click() }, "separator"] as MenuEntry[]) : []),
                  { label: prefs.filesShowHidden ? "Hide hidden files" : "Show hidden files", icon: prefs.filesShowHidden ? <EyeClosed /> : <Eye />, onSelect: () => void setPrefs({ filesShowHidden: !prefs.filesShowHidden }) },
                  ...(listing ? ([{ label: "Calculate folder sizes", icon: <Refresh />, onSelect: () => void measure({ path: listing.path, name: listing.name }, true) }] as MenuEntry[]) : []),
                  { label: "Select all", hint: "⌘A", onSelect: () => void selectAll() },
                  "separator",
                  ...(listing ? ([{ label: "Copy path", icon: <Copy />, onSelect: () => copyText(listing.path) }, { label: "Properties", icon: <InfoCircle />, onSelect: () => setProps({ path: listing.path }) }] as MenuEntry[]) : []),
                  ...(isAdmin && listing ? ([{ label: "Used by apps", onSelect: () => setProps({ path: listing.path, focus: "apps" }) }] as MenuEntry[]) : []),
                  { label: "Trash", icon: <Trash />, onSelect: () => navigate("", "trash") },
                ]}
              />
              {writable && (
                <>
                  <IconButton label="New folder" onClick={() => setNewFolder(true)}>
                    <FolderPlus />
                  </IconButton>
                  <Button icon={<Upload />} variant="primary" onClick={() => fileInput.current?.click()}>
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
              onNavigate={navigate}
              onUpload={() => fileInput.current?.click()}
              onNewFolder={() => setNewFolder(true)}
              onDeepSearch={() => setDeepQuery(filter)}
              firstPlace={places.data?.places[0]?.path ?? null}
            >
              {listing && (
                <Listing
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
                  reveal={reveal}
                  onOpen={open}
                  onPreview={(e) => setPreview(e)}
                  onUp={() => listing.parent && navigate(listing.parent)}
                  onTrash={(es) => void trashEntries(es)}
                  onRename={(e) => setRenaming(e.path)}
                  onRenameCommit={(e, n) => void renameCommit(e, n)}
                  onRenameCancel={() => setRenaming(null)}
                  onCalculate={(e) => void measure(e)}
                  onDropItems={onDropItems}
                  menuFor={menuFor}
                  backgroundMenu={backgroundMenu}
                  onSelectAll={() => void selectAll()}
                  dropPath={dropInto?.path ?? null}
                  showOwner={isAdmin}
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
            <div className={s.floatBar} role="toolbar" aria-label={`${fmt.plural(selected.size, "item")} selected`}>
              <span className={`${s.floatCount} num`}>{fmt.plural(selected.size, "item")}</span>
              <span className={s.floatRule} aria-hidden />
              <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void download(selectedEntries)}>
                {phone ? "Get" : "Download"}
              </Button>
              <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => setPicker({ mode: "copy", sources: [...selected] })}>
                {phone ? "Copy" : "Copy to…"}
              </Button>
              {writable && (
                <>
                  <Button size="sm" variant="ghost" icon={<DataTransferBoth />} onClick={() => setPicker({ mode: "move", sources: [...selected] })}>
                    {phone ? "Move" : "Move to…"}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash />} onClick={() => void trashEntries(selectedEntries)}>
                    Trash
                  </Button>
                </>
              )}
              <span className={s.floatRule} aria-hidden />
              <IconButton label="Clear selection" size="sm" shortcut="Esc" onClick={() => setSelected(new Set())}>
                <Xmark />
              </IconButton>
            </div>
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

      <NewFolderDialog
        open={newFolder}
        dir={listing?.path ?? path}
        onClose={() => setNewFolder(false)}
        onCreated={async (p) => {
          await L.refresh();
          setReveal(p);
          setSelected(new Set([p]));
        }}
      />
      <Preview entry={preview} siblings={siblings} onNavigate={setPreview} onClose={() => setPreview(null)} canWrite={writable} onExtract={(e) => void extract(e)} onSaved={() => void L.refresh()} />
      <Properties path={props?.path ?? null} focus={props?.focus} onClose={() => setProps(null)} onFixOwnership={isAdmin ? (p) => { setProps(null); setOwnershipPath(p); } : undefined} />
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
      {conflictNode}
      {confirmNode}
    </Page>
  );
}

function FolderBody({
  L,
  path,
  writable,
  filter,
  onNavigate,
  onUpload,
  onNewFolder,
  onDeepSearch,
  firstPlace,
  children,
}: {
  L: ReturnType<typeof useListing>;
  path: string;
  writable: boolean;
  filter: string;
  onNavigate: (p: string) => void;
  onUpload: () => void;
  onNewFolder: () => void;
  onDeepSearch: () => void;
  firstPlace: string | null;
  children: React.ReactNode;
}) {
  const fmt = useFormat();
  const { listing, error } = L;
  if (error) {
    if (error.code === "not_found") {
      return (
        <Notice title="This folder doesn't exist any more" action={path !== "/" ? <Button size="sm" onClick={() => onNavigate(parentOf(path))}>Go up</Button> : undefined}>
          <span className="mono">{path}</span> may have been moved, renamed or deleted, or its drive isn't mounted.
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
  if (!listing) {
    return (
      <div className={s.listing} aria-busy>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className={s.row}>
            <span />
            <span className={s.nameCell}>
              <Skeleton width={18} height={18} radius={4} />
              <Skeleton width={`${28 + ((i * 23) % 45)}%`} />
            </span>
            <Skeleton width={56} />
          </div>
        ))}
      </div>
    );
  }
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
          title="This folder is empty"
          action={
            <>
              <Button variant="primary" icon={<Upload />} onClick={onUpload}>
                Upload files
              </Button>
              <Button icon={<FolderPlus />} onClick={onNewFolder}>
                New folder
              </Button>
            </>
          }
        >
          Drag files or whole folders here from your computer to upload them. Big uploads carry on where they stopped if the connection drops.
          {listing.counts.hidden > 0 && ` There ${listing.counts.hidden === 1 ? "is" : "are"} also ${fmt.plural(listing.counts.hidden, "hidden item")}.`}
        </Empty>
      );
    } else {
      content = <Empty title="This folder is empty">{listing.counts.hidden > 0 ? `It only has ${fmt.plural(listing.counts.hidden, "hidden item")}. Turn on “Show hidden files” to see them.` : "Nothing has been put here yet."}</Empty>;
    }
  }
  return (
    <>
      {notices.length > 0 && <div className={s.notices}>{notices}</div>}
      {content}
    </>
  );
}

function NewFolderDialog({ open, dir, onClose, onCreated }: { open: boolean; dir: string; onClose: () => void; onCreated: (path: string) => void }) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const e = await api.post<FileEntry>("/api/files/mkdir", { path: dir, name: name.trim() });
      onClose();
      onCreated(e.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the folder.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New folder"
      description={
        <>
          In <span className="mono">{dir}</span>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
            Create folder
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Name" error={error}>
          <Input autoFocus value={name} onChange={(e) => (setName(e.target.value), setError(null))} maxLength={255} />
        </Field>
      </form>
    </Dialog>
  );
}
