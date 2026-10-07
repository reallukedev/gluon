"use client";
import * as React from "react";
import { mutate as globalMutate } from "swr";
import { Archive, Copy, DataTransferBoth, Download, EditPencil, InfoCircle, MultiplePages, OpenInWindow, PasteClipboard, Pin, PinSlash, Refresh, Scissor, Trash, UserCrown } from "iconoir-react";
import type { FileEntry, FileJob, FolderSize, Listing as ListingT, Places, UploadSession, ZipEstimate } from "@/lib/files-types";
import { api, ApiError, useStream } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { useConfirm } from "@/components/ui/Dialog";
import type { MenuEntry } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { useConflicts } from "./Conflicts";
import { FolderPicker } from "./FolderPicker";
import { Properties, copyText } from "./Properties";
import { Ownership } from "./Ownership";
import { Tray } from "./Tray";
import { uploads } from "./uploads";
import { clip } from "./clip";
import { fromInput, type Incoming } from "./drop";
import { baseName, downloadUrl, isArchive as isArchiveName, isDirLike, joinPath, modKey, parentOf, rawUrl } from "./lib";
import { planUpload, uploadTops } from "./logic";

// ---------------------------------------------------------------- actions

export interface ActionContext {
  /** Folder being shown (for "here" in messages and as the default destination). */
  here: ListingT | undefined;
  places: Places | undefined;
  refresh: () => void;
}

/**
 * Every file operation the explorer can do, with the same confirmations, conflict questions,
 * undo toasts and background tasks as the current Files page. `nodes` holds the dialogs and the
 * tasks tray; render it once.
 */
export function useFileActions({ here, places, refresh }: ActionContext) {
  const fmt = useFormat();
  const { viewer } = usePrefs();
  const isAdmin = viewer.role === "admin";
  const [askConflicts, conflictNode] = useConflicts();
  const [confirm, confirmNode] = useConfirm();
  const [picker, setPicker] = React.useState<{ mode: "copy" | "move"; sources: string[] } | null>(null);
  const [props, setProps] = React.useState<{ path: string; focus?: "apps" | "size" } | null>(null);
  const [ownershipPath, setOwnershipPath] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<Map<string, FileJob>>(new Map());
  const mountedAt = React.useRef(Date.now());
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;
  const hereRef = React.useRef(here);
  hereRef.current = here;

  const nameOf = React.useCallback((list: { name: string }[]) => (list.length === 1 ? list[0]!.name : fmt.plural(list.length, "item")), [fmt]);
  const fail = (title: string) => (e: unknown) => toast.error(title, { description: e instanceof Error ? e.message : undefined });

  const upsertJob = React.useCallback((j: FileJob) => {
    setJobs((cur) => {
      const prev = cur.get(j.id);
      const next = new Map(cur);
      next.set(j.id, j);
      const ended = j.status !== "running" && j.status !== "queued";
      if (prev && (prev.status === "running" || prev.status === "queued") && ended) {
        if (j.status === "done") toast.success(j.message ?? j.title);
        else if (j.status === "failed") toast.error(j.title, { description: j.error ?? j.message ?? undefined });
        setTimeout(() => refreshRef.current(), 50);
      }
      return next;
    });
  }, []);

  useStream("/api/files/jobs/stream", {
    snapshot: (d) => setJobs(new Map((d as FileJob[]).filter((j) => j.status === "running" || j.status === "queued" || (j.finishedAt ?? 0) > mountedAt.current).map((j) => [j.id, j]))),
    job: (d) => upsertJob(d as FileJob),
    upload: (d) => {
      const u = d as UploadSession;
      if (u.status === "done" && u.dir === hereRef.current?.path) refreshRef.current();
    },
  });
  React.useEffect(() => {
    void uploads.loadInterrupted();
    return uploads.onFinished((it) => {
      if (it.dir === hereRef.current?.path) refreshRef.current();
    });
  }, []);

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

  async function trash(entries: FileEntry[], after?: () => void) {
    if (!entries.length) return;
    try {
      const r = await api.post<{ items: { id: string; name: string }[] }>("/api/files/trash", { paths: entries.map((e) => e.path) });
      after?.();
      refresh();
      const ids = r.items.map((i) => i.id);
      const t = toast.success(`Moved ${nameOf(r.items)} to the trash`, {
        action: {
          label: "Undo",
          onClick: () => {
            toast.dismiss(t);
            void api
              .post("/api/files/trash/restore", { ids, conflict: "rename" })
              .then(() => {
                refreshRef.current();
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

  async function rename(e: FileEntry, name: string): Promise<FileEntry | null> {
    try {
      const r = await api.post<FileEntry>("/api/files/rename", { path: e.path, name });
      refresh();
      if (e.pinned) void globalMutate("/api/shell");
      return r;
    } catch (err) {
      fail(`Couldn't rename ${e.name}`)(err);
      return null;
    }
  }

  /** A new folder with the first free name ("New folder 2"), ready to be renamed in place. */
  async function newFolder(dir: string, taken: Iterable<string>): Promise<FileEntry | null> {
    const names = new Set([...taken].map((n) => n.toLowerCase()));
    for (let i = 1; i < 60; i++) {
      const name = i === 1 ? "New folder" : `New folder ${i}`;
      if (names.has(name.toLowerCase())) continue;
      try {
        const made = await api.post<FileEntry>("/api/files/mkdir", { path: dir, name });
        refresh();
        return made;
      } catch (e) {
        if (e instanceof ApiError && e.code === "conflict") continue;
        fail("Couldn't make a folder here")(e);
        return null;
      }
    }
    toast.error("Couldn't find a free name", { description: "Rename some of the new folders here first." });
    return null;
  }

  async function undoMove(moved: { from: string; to: string }[]) {
    try {
      const back = new Map<string, string[]>();
      for (const m of moved) back.set(parentOf(m.from), [...(back.get(parentOf(m.from)) ?? []), m.to]);
      for (const [dest, sources] of back) await api.post("/api/files/move", { sources, dest, conflict: "rename" });
      refreshRef.current();
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
        toast.info("Nothing to do. Everything was skipped.");
        return false;
      }
      const moved: { from: string; to: string }[] = [];
      let started = false;
      for (const [conflict, list] of groups) {
        const r = await api.post<{ job: FileJob | null; moved?: { from: string; to: string }[] }>(`/api/files/${mode}`, { sources: list, dest, conflict });
        if (r.job) {
          upsertJob(r.job);
          started = true;
        }
        moved.push(...(r.moved ?? []));
      }
      const where = dest === hereRef.current?.path ? "here" : `to ${baseName(dest) === "/" ? "Computer" : baseName(dest)}`;
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
      } else if (started) toast.info(`${mode === "copy" ? "Copying" : "Moving"} ${where}`, { description: "Progress is in the tasks tray. You can keep working." });
      refresh();
      return true;
    } catch (e) {
      fail(mode === "copy" ? "Couldn't copy" : "Couldn't move")(e);
      return false;
    }
  }

  /** Upload picked files into `dest`, asking about names that are already there. */
  /** Every name in a folder (up to 20,000), so a clash past the first page isn't missed. */
  async function namesIn(dir: string): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const l = await api.get<ListingT>(`/api/files/list?path=${encodeURIComponent(dir)}&hidden=1&limit=1000&offset=${offset}`);
      out.push(...l.entries);
      if (out.length >= l.total || !l.entries.length) break;
    }
    return out;
  }

  /** Upload picked or dropped files into `dest`, asking first about names that are already there. */
  async function upload(incoming: { files: Incoming[]; dirs: string[] }, dest: string) {
    if (!incoming.files.length && !incoming.dirs.length) return;
    try {
      const existing = await namesIn(dest);
      const byName = new Map(existing.map((e) => [e.name, e]));
      const picks = incoming.files.map((f) => ({ rel: f.rel, name: f.file.name, size: f.file.size }));
      const clashes = [...uploadTops(picks, incoming.dirs)].filter(([n]) => byName.has(n)).map(([n, t]) => ({ name: n, isDir: t.isDir, existing: byName.get(n)!, size: t.size }));
      const answers = await askConflicts(clashes, dest, "upload");
      if (!answers) return;
      const plan = planUpload(picks, incoming.dirs, new Set(byName.keys()), answers);
      for (const d of plan.dirs) {
        const parent = d.includes("/") ? joinPath(dest, d.slice(0, d.lastIndexOf("/"))) : dest;
        try {
          await api.post("/api/files/mkdir", { path: parent, name: d.slice(d.lastIndexOf("/") + 1) });
        } catch (e) {
          if (!(e instanceof ApiError && e.code === "conflict")) throw e;
        }
      }
      if (plan.dirs.length) refresh();
      const list = plan.files.map((p) => ({ file: incoming.files[p.index]!.file, dir: p.dir ? joinPath(dest, p.dir) : dest, conflict: p.conflict }));
      if (!list.length) return void (plan.dirs.length ? toast.success(`Made ${fmt.plural(plan.dirs.length, "folder")} in ${baseName(dest) || "/"}`) : toast.info("Nothing to upload. Everything was skipped."));
      uploads.enqueue(list);
      const bytes = list.reduce((a, x) => a + x.file.size, 0);
      toast.info(`Uploading ${fmt.plural(list.length, "file")} (${fmt.bytes(bytes)}) to ${baseName(dest) || "/"}`, { description: "Keep this tab open. If the connection drops, uploads continue where they stopped." });
    } catch (e) {
      fail("Couldn't start the upload")(e);
    }
  }

  async function togglePin(e: { path: string; name: string; pinned: FileEntry["pinned"] }) {
    try {
      if (e.pinned) await api.del("/api/me/pins", { id: e.pinned.id });
      else await api.post("/api/me/pins", { kind: "folder", target: e.path, label: e.name.slice(0, 60) || e.path });
      void globalMutate("/api/shell");
      refresh();
      toast.success(e.pinned ? `Unpinned ${e.name}` : `Pinned ${e.name}`);
    } catch (err) {
      fail("Couldn't change the pin")(err);
    }
  }

  async function extract(e: FileEntry) {
    try {
      const r = await api.post<{ job: FileJob }>("/api/files/extract", { path: e.path });
      upsertJob(r.job);
    } catch (err) {
      fail(`Couldn't extract ${e.name}`)(err);
    }
  }

  /** A new, empty text file with a free name, ready to be renamed in place. */
  async function newTextFile(dir: string, taken: Iterable<string>): Promise<FileEntry | null> {
    const names = new Set([...taken].map((n) => n.toLowerCase()));
    for (let i = 1; i < 60; i++) {
      const name = i === 1 ? "New text file.txt" : `New text file ${i}.txt`;
      if (names.has(name.toLowerCase())) continue;
      try {
        const made = await api.put<{ path: string }>("/api/files/text", { path: joinPath(dir, name), content: "", expectedMtime: null, create: true });
        refresh();
        return await api.get<FileEntry>(`/api/files/stat?path=${encodeURIComponent(made.path)}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === "conflict") continue;
        fail("Couldn't make a file here")(e);
        return null;
      }
    }
    return null;
  }

  // ---- the Files clipboard: ⌘C or ⌘X in one folder, ⌘V in another
  const mod = typeof window === "undefined" ? "Ctrl+" : modKey();
  function toClipboard(mode: "copy" | "cut", targets: FileEntry[], from: string) {
    if (!targets.length) return;
    clip.set({ mode, paths: targets.map((t) => t.path), first: targets[0]!.name, from });
    toast.info(mode === "cut" ? `Cut ${nameOf(targets)}` : `Copied ${nameOf(targets)}`, { description: `Open another folder and paste with ${mod}V.`, timeout: 2600 });
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

  /** Measure a folder (or every folder in it) now, with the result in a toast. */
  async function measure(target: { path: string; name: string }, all = false) {
    const t = toast.loading(all ? `Measuring the folders in ${target.name}…` : `Measuring ${target.name}…`);
    const url = `/api/files/size?path=${encodeURIComponent(target.path)}`;
    try {
      let r = await api.get<FolderSize>(`${url}&refresh=1`);
      for (let i = 0; r.running && i < 600; i++) {
        await new Promise((ok) => setTimeout(ok, 2500));
        r = await api.get<FolderSize>(url);
        if (i === 2 && r.running) refreshRef.current();
      }
      refreshRef.current();
      if (r.bytes === null) toast.update(t, "error", { title: `Couldn't measure ${target.name}`, description: r.error ?? undefined });
      else toast.update(t, "success", { title: `${target.name} uses ${fmt.bytes(r.bytes)}${r.partial ? " or more" : ""}` });
    } catch (e) {
      toast.update(t, "error", { title: `Couldn't measure ${target.name}`, description: e instanceof Error ? e.message : undefined });
    }
  }

  // Hidden pickers for the Upload buttons; screens call `pickFiles(dest)`.
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const pickDest = React.useRef<string | null>(null);
  const pickFiles = (dest: string, folder = false) => {
    pickDest.current = dest;
    (folder ? folderInput : fileInput).current?.click();
  };

  const nodes = (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].map((f) => ({ file: f, rel: "" }));
          e.target.value = "";
          if (pickDest.current) void upload({ files, dirs: [] }, pickDest.current);
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
          if (pickDest.current) void upload(r, pickDest.current);
        }}
      />
      <FolderPicker
        open={!!picker}
        onOpenChange={(o) => !o && setPicker(null)}
        title={picker?.mode === "move" ? `Move ${fmt.plural(picker?.sources.length ?? 0, "item")} to…` : `Copy ${fmt.plural(picker?.sources.length ?? 0, "item")} to…`}
        confirmLabel={(n) => `${picker?.mode === "move" ? "Move" : "Copy"} to ${n}`}
        initialPath={here?.path ?? "/"}
        places={places}
        onPick={(dest) => picker && void transfer(picker.sources, dest, picker.mode)}
      />
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
      <Tray
        jobs={[...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)}
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
    </>
  );

  const impl = {
    download,
    trash,
    rename,
    newFolder,
    transfer,
    upload,
    togglePin,
    extract,
    pickFiles,
    upsertJob,
    newTextFile,
    toClipboard,
    paste,
    measure,
    copyPath: (p: string) => copyText(p),
    moveTo: (sources: string[]) => setPicker({ mode: "move", sources }),
    copyTo: (sources: string[]) => setPicker({ mode: "copy", sources }),
    properties: (path: string, focus?: "apps" | "size") => setProps({ path, focus }),
    fixOwnership: (path: string) => setOwnershipPath(path),
  };
  // One object for the life of the page whose methods always call the latest code, so screens
  // and memoised rows that hold it don't re-render when Files does.
  const latest = React.useRef(impl);
  latest.current = impl;
  const stable = React.useMemo(() => {
    const out = {} as typeof impl;
    for (const k of Object.keys(impl) as (keyof typeof impl)[]) (out as Record<string, unknown>)[k] = (...args: unknown[]) => (latest.current[k] as (...a: unknown[]) => unknown)(...args);
    return out;
    // Built once; `latest` carries the changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const actions = React.useMemo(() => ({ ...stable, isAdmin }), [stable, isAdmin]);
  return { actions, nodes };
}

export type FileActions = ReturnType<typeof useFileActions>["actions"];

// ---------------------------------------------------------------- the item menu

export interface MenuContext {
  actions: FileActions;
  writable: boolean;
  /** Folder the items are in (for Duplicate). */
  dir: string;
  onOpen: (e: FileEntry) => void;
  onRename?: (e: FileEntry) => void;
  after?: () => void;
}

/** Everything you can do to the given items, in the order people look for it. */
export function entryMenu(targets: FileEntry[], c: MenuContext): MenuEntry[] {
  const { actions: a, writable } = c;
  const one = targets.length === 1 ? targets[0]! : null;
  const dir = one ? isDirLike(one) : false;
  const paths = targets.map((t) => t.path);
  const mod = modKey();
  const held = clip.get();
  const items: MenuEntry[] = [];
  if (one) items.push({ label: dir ? "Open" : "Quick look", icon: <OpenInWindow />, hint: dir ? "↵" : "Space", onSelect: () => c.onOpen(one) });
  items.push({ label: targets.length > 1 || dir ? "Download as zip" : "Download", icon: <Download />, onSelect: () => void a.download(targets) });
  items.push("separator");
  if (writable && one && c.onRename) items.push({ label: "Rename", icon: <EditPencil />, hint: "F2", onSelect: () => c.onRename!(one) });
  if (writable) items.push({ label: "Cut", icon: <Scissor />, hint: `${mod}X`, onSelect: () => a.toClipboard("cut", targets, c.dir) });
  items.push({ label: "Copy", icon: <Copy />, hint: `${mod}C`, onSelect: () => a.toClipboard("copy", targets, c.dir) });
  if (one && dir && writable && held && !held.paths.includes(one.path)) items.push({ label: `Paste into ${one.name}`, icon: <PasteClipboard />, onSelect: () => void a.paste(one.path) });
  if (writable) items.push({ label: "Duplicate", icon: <MultiplePages />, hint: `${mod}D`, onSelect: () => void a.transfer(paths, c.dir, "copy") });
  items.push({ label: "Copy to…", icon: <Copy />, onSelect: () => a.copyTo(paths) });
  if (writable) items.push({ label: "Move to…", icon: <DataTransferBoth />, onSelect: () => a.moveTo(paths) });
  if (one && dir) {
    items.push("separator");
    items.push({ label: one.pinned ? "Unpin folder" : "Pin folder", icon: one.pinned ? <PinSlash /> : <Pin />, onSelect: () => void a.togglePin(one) });
    items.push({ label: one.dirSize ? "Measure again" : "Measure size", icon: <Refresh />, onSelect: () => void a.measure(one) });
    if (a.isAdmin) {
      items.push({ label: "Show apps using it", onSelect: () => a.properties(one.path, "apps") });
      items.push({ label: "Fix ownership for an app…", icon: <UserCrown />, onSelect: () => a.fixOwnership(one.path) });
    }
  }
  if (one && !dir && isArchiveName(one.name) && writable) items.push({ label: "Extract here", icon: <Archive />, onSelect: () => void a.extract(one) });
  if (one) {
    items.push("separator");
    items.push({ label: "Copy path", onSelect: () => a.copyPath(one.path) });
    items.push({ label: "Properties", icon: <InfoCircle />, onSelect: () => a.properties(one.path) });
  }
  if (writable) {
    items.push("separator");
    items.push({ label: targets.length > 1 ? `Move ${targets.length} items to the trash` : "Move to the trash", icon: <Trash />, hint: "Del", danger: true, onSelect: () => void a.trash(targets, c.after) });
  }
  return items;
}

