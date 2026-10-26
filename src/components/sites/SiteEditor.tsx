"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHoriz, OpenNewWindow, Copy, Download, EditPencil, Internet, Trash, PagePlus, FolderPlus, Upload, Prohibition } from "iconoir-react";
import { api, ApiError } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { useMediaQuery } from "@/lib/client/motion";
import { Page, PageHeader, Notice, Skeleton, Kbd, UsageBar } from "@/components/ui/Surface";
import { Button, IconButton, buttonClass } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Segmented } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { formatBytes, plural } from "@/lib/format";
import { isImage, languageOf, type SiteDetail, type SiteFileContent, type SitePreview, type SiteTextFile, type SiteTree } from "@/lib/sites-types";
import { fileUrl, fromDrop, fromInput, importZip, join, sortPicked, uploadAll, useSite, useTree, type Picked, type UploadProgress } from "./client";
import { FileTree, uploadEntries, type TreeAction } from "./FileTree";
import { CodePane } from "./CodePane";
import { PreviewPane, usePreview } from "./PreviewPane";
import { PublishDialog } from "./PublishDialog";
import { VersionStrip } from "./VersionStrip";
import { MoveDialog, NameDialog } from "./dialogs";
import e from "./editor.module.css";

type Buffer = { file: SiteTextFile; text: string; key: number };
type Pane = "files" | "code" | "preview";
type Conflict = { path: string; kind: "changed" | "gone" };
type Ask =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; path: string; dir: boolean }
  | { kind: "move"; path: string; dir: boolean }
  | { kind: "rename-site" }
  | { kind: "publish"; address?: boolean };

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

function blankFor(path: string, siteName: string): string {
  if (!path.toLowerCase().endsWith(".html")) return "";
  const title = path.split("/").pop()!.replace(/\.html$/i, "").replace(/[-_]+/g, " ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.charAt(0).toUpperCase()}${title.slice(1)} · ${siteName.replace(/[<>&]/g, "")}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>${title.charAt(0).toUpperCase()}${title.slice(1)}</h1>
  </main>
</body>
</html>
`;
}

function sentence(site: SiteDetail, dirty: number): React.ReactNode {
  const host = site.address?.host;
  const unsaved = dirty ? ` ${dirty === 1 ? "One file has" : `${dirty} files have`} edits that aren't saved yet.` : "";
  switch (site.state) {
    case "draft":
      return (
        <>
          <b>Not published yet.</b> Edit the files, check the preview, then publish it to an address.{unsaved}
        </>
      );
    case "live":
      return (
        <>
          <b>Live at {host}.</b> {dirty ? unsaved.trim() : site.changes ? "You have changes that aren't published yet." : "The draft is the same as what's live."}
        </>
      );
    case "off":
      return (
        <>
          <b>Offline.</b> {host} is turned off; publishing puts it back.{unsaved}
        </>
      );
    case "broken":
      return host ? (
        <>
          <b>{host} isn&rsquo;t serving anything.</b> The version it points at is gone or its entry in routes.json was changed by hand. Publish again to fix it.{unsaved}
        </>
      ) : (
        <>
          <b>This site&rsquo;s address can&rsquo;t be used.</b> Its entry in routes.json was changed by hand. Publish again to give it an address.{unsaved}
        </>
      );
  }
}

export function SiteEditor({ initial, openFile }: { initial: SiteDetail; openFile: string | null }) {
  const id = initial.id;
  const router = useRouter();
  const { data: site = initial, mutate: refreshSite } = useSite(id, initial);
  const { data: tree, mutate: setTree } = useTree(id);
  const [path, setPath] = React.useState<string | null>(openFile);
  const [buffers, setBuffers] = React.useState<Record<string, Buffer>>({});
  const [other, setOther] = React.useState<SiteFileContent | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const [page, setPage] = React.useState("index.html");
  const [nonce, setNonce] = React.useState(0);
  const [pane, setPane] = React.useState<Pane>("code");
  const [ask, setAsk] = React.useState<Ask | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [upload, setUpload] = React.useState<UploadProgress | null>(null);
  // A new object each time, so revealing the same folder twice opens it again.
  const [reveal, setReveal] = React.useState<{ path: string } | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const { preview, error: previewError } = usePreview(id);
  const wide = useMediaQuery("(min-width: 1180px)");
  const phone = useMediaQuery("(max-width: 719px)");
  const mac = React.useSyncExternalStore(
    () => () => undefined,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => true,
  );
  const ownRev = React.useRef<number | null>(null);
  const uploadDir = React.useRef("");
  const filesRef = React.useRef<HTMLInputElement>(null);
  const folderRef = React.useRef<HTMLInputElement>(null);
  const zipRef = React.useRef<HTMLInputElement>(null);

  const dirtyPaths = React.useMemo(() => Object.entries(buffers).filter(([, b]) => b.text !== b.file.text).map(([p]) => p), [buffers]);
  const dirtySet = React.useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const buf = path ? buffers[path] : undefined;
  const dirty = !!buf && buf.text !== buf.file.text;
  const pages = React.useMemo(() => (tree?.files ?? []).filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path), [tree]);
  const hasIndex = !!tree?.files.some((f) => f.path === "index.html");

  const applyTree = React.useCallback(
    (t: SiteTree) => {
      ownRev.current = t.rev;
      void setTree(t, { revalidate: false });
    },
    [setTree],
  );

  const load = React.useCallback(
    async (p: string, replace = false) => {
      setLoadError(null);
      setConflict((c) => (c?.path === p ? null : c));
      if (!replace && buffers[p]) {
        setOther(null);
        return;
      }
      setLoading(true);
      try {
        const f = await api.get<SiteFileContent>(`/api/sites/${id}/file?path=${encodeURIComponent(p)}`);
        if (f.kind === "text") {
          setBuffers((b) => ({ ...b, [p]: { file: f, text: f.text, key: (b[p]?.key ?? 0) + 1 } }));
          setOther(null);
        } else setOther(f);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "It didn't open.");
      } finally {
        setLoading(false);
      }
    },
    [buffers, id],
  );

  function open(p: string) {
    setPath(p);
    if (/\.html?$/i.test(p)) setPage(p);
    if (!isImage(p) || p.toLowerCase().endsWith(".svg")) void load(p);
    else {
      setOther(null);
      setLoadError(null);
    }
    if (!wide) setPane("code");
    // The link follows the open file without asking the server for the page again.
    window.history.replaceState(null, "", `/sites/${id}?file=${encodeURIComponent(p)}`);
  }

  // First file: the one in the link, else the front page, else whatever's there.
  React.useEffect(() => {
    if (!tree || path) return;
    const first = tree.files.find((f) => f.path === "index.html") ?? tree.files.find((f) => /\.html?$/i.test(f.path)) ?? tree.files[0];
    if (first) open(first.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, path]);
  React.useEffect(() => {
    if (openFile) open(openFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Someone changed the files elsewhere (another tab): reload what's open, or warn if it has edits.
  React.useEffect(() => {
    if (!tree || ownRev.current === null) {
      if (tree) ownRev.current = tree.rev;
      return;
    }
    if (tree.rev === ownRev.current) return;
    ownRev.current = tree.rev;
    for (const [p, b] of Object.entries(buffers)) {
      const f = tree.files.find((x) => x.path === p);
      const edited = b.text !== b.file.text;
      if (!f) {
        if (edited) setConflict({ path: p, kind: "gone" });
        else
          setBuffers((all) => {
            const { [p]: _gone, ...rest } = all;
            return rest;
          });
        continue;
      }
      if (f.size === b.file.size && !edited) continue;
      void api
        .get<SiteFileContent>(`/api/sites/${id}/file?path=${encodeURIComponent(p)}`)
        .then((cur) => {
          if (cur.kind !== "text" || cur.etag === b.file.etag) return;
          if (edited) setConflict({ path: p, kind: "changed" });
          else setBuffers((all) => ({ ...all, [p]: { file: cur, text: cur.text, key: b.key + 1 } }));
        })
        .catch(() => undefined);
    }
    if (path && !tree.files.some((f) => f.path === path) && !buffers[path]) setPath(null);
    void refreshSite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree?.rev]);

  const save = React.useCallback(
    async (p: string | null = path, opts: { force?: boolean; asNew?: boolean } = {}): Promise<boolean> => {
      if (!p) return true;
      const b = buffers[p];
      if (!b) return true;
      setSaving(true);
      try {
        const r = await api.put<{ etag: string; tree: SiteTree }>(`/api/sites/${id}/file`, { path: p, text: b.text, etag: opts.asNew ? null : b.file.etag, force: opts.force });
        setBuffers((all) => (all[p] ? { ...all, [p]: { ...all[p]!, file: { ...all[p]!.file, text: b.text, etag: r.etag, size: new Blob([b.text]).size } } } : all));
        setConflict((c) => (c?.path === p ? null : c));
        applyTree(r.tree);
        setNonce((n) => n + 1);
        void refreshSite();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && (err.details?.conflict === "changed" || err.details?.conflict === "gone")) {
          setConflict({ path: p, kind: err.details.conflict as Conflict["kind"] });
        } else toast.error(`Couldn't save ${p}`, { description: err instanceof Error ? err.message : undefined });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [applyTree, buffers, id, path, refreshSite],
  );

  async function saveAll(): Promise<boolean> {
    for (const p of dirtyPaths) if (!(await save(p))) return false;
    return true;
  }

  // ⌘S / Ctrl+S anywhere on the page saves the open file instead of saving the web page.
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Unsaved edits: the browser asks before closing the tab, and Gluon asks before following a link away.
  React.useEffect(() => {
    if (!dirtyPaths.length) return;
    const onUnload = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = "";
    };
    const onClick = (ev: MouseEvent) => {
      const a = (ev.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      ev.preventDefault();
      ev.stopPropagation();
      confirm({
        title: dirtyPaths.length === 1 ? `Leave without saving ${dirtyPaths[0]}?` : `Leave without saving ${dirtyPaths.length} files?`,
        description: "Your changes are only in this tab until you save them.",
        confirmLabel: "Leave without saving",
        variant: "danger",
        onConfirm: () => {
          setBuffers({});
          router.push(url.pathname + url.search);
        },
      });
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirtyPaths, confirm, router]);

  // ---------------------------------------------------------------- file actions

  async function op(body: Record<string, unknown>): Promise<SiteTree> {
    const t = await api.post<SiteTree>(`/api/sites/${id}/files`, body);
    applyTree(t);
    setNonce((n) => n + 1);
    void refreshSite();
    return t;
  }

  function onTreeAction(a: TreeAction) {
    switch (a.kind) {
      case "new-file":
      case "new-folder":
      case "rename":
      case "move":
        setAsk(a);
        return;
      case "download":
        window.location.href = fileUrl(id, a.path, true);
        return;
      case "upload":
        uploadDir.current = a.dir;
        (a.what === "files" ? filesRef : a.what === "folder" ? folderRef : zipRef).current?.click();
        return;
      case "delete": {
        const inside = a.dir ? (tree?.files.filter((f) => under(f.path, a.path)).length ?? 0) : 0;
        const edited = dirtyPaths.filter((p) => under(p, a.path));
        confirm({
          title: `Delete ${a.path}?`,
          consequences: [
            a.dir ? (inside === 1 ? "The folder and the file in it are deleted from the draft." : inside ? `The folder and the ${inside} files in it are deleted from the draft.` : "The empty folder is deleted from the draft.") : "It's deleted from the draft.",
            ...(edited.length ? [`Changes you haven't saved in ${edited.join(", ")} are lost.`] : []),
            site.state === "live" ? "What's live doesn't change until you publish." : "Published versions keep their copy.",
          ],
          confirmLabel: a.dir ? "Delete folder" : "Delete file",
          variant: "dangerSolid",
          onConfirm: async () => {
            await op({ op: "delete", paths: [a.path] });
            setBuffers((all) => Object.fromEntries(Object.entries(all).filter(([p]) => !under(p, a.path))));
            if (path && under(path, a.path)) setPath(null);
            toast.success(`Deleted ${a.path}`);
          },
        });
      }
    }
  }

  async function rename(from: string, to: string) {
    await op({ op: "move", from, to });
    setBuffers((all) => {
      const next: Record<string, Buffer> = {};
      for (const [p, b] of Object.entries(all)) {
        const np = under(p, from) ? to + p.slice(from.length) : p;
        next[np] = { ...b, file: { ...b.file, path: np } };
      }
      return next;
    });
    if (path && under(path, from)) setPath(to + path.slice(from.length));
    if (under(page, from)) setPage(to + page.slice(from.length));
  }

  async function sendFiles(items: Picked[], dir: string) {
    const { ok, skipped, junk } = sortPicked(items);
    if (!ok.length) {
      if (skipped.length) toast.error(`${plural(skipped.length, "file")} can't go on a site`, { description: `${skipped[0]!.rel}: ${skipped[0]!.reason}` });
      return;
    }
    const existing = new Set(tree?.files.map((f) => f.path) ?? []);
    const clash = ok.filter((p) => existing.has(p.rel));
    const go = async () => {
      setUpload({ done: 0, total: ok.length, bytesDone: 0, bytesTotal: 0, current: null });
      const r = await uploadAll(id, ok, true, setUpload);
      setUpload(null);
      if (r.tree) applyTree(r.tree);
      if (dir) setReveal({ path: dir });
      setNonce((n) => n + 1);
      void refreshSite();
      for (const p of clash) if (buffers[p.rel] && buffers[p.rel]!.text === buffers[p.rel]!.file.text) void load(p.rel, true);
      const notes = [skipped.length ? `${plural(skipped.length, "file")} left out: ${skipped[0]!.reason}` : "", junk ? `${plural(junk, "hidden system file")} skipped` : ""].filter(Boolean).join(". ");
      if (r.failed.length) toast.error(`${plural(r.failed.length, "file")} didn't upload`, { description: `${r.failed[0]!.rel}: ${r.failed[0]!.message}` });
      else toast.success(`Uploaded ${plural(r.done, "file")}${dir ? ` to ${dir}` : ""}`, notes ? { description: notes } : undefined);
    };
    if (clash.length) {
      confirm({
        title: clash.length === 1 ? `Replace ${clash[0]!.rel}?` : `Replace ${clash.length} files?`,
        description: clash.length === 1 ? "A file with that name is already in the draft." : `These are already in the draft: ${clash.slice(0, 4).map((c) => c.rel).join(", ")}${clash.length > 4 ? ` and ${clash.length - 4} more` : ""}.`,
        confirmLabel: clash.length === 1 ? "Replace it" : "Replace them",
        onConfirm: go,
      });
    } else await go();
  }

  async function sendZip(file: File, dir: string) {
    setBusy("zip");
    try {
      const r = await importZip(id, file, dir);
      applyTree(r.tree);
      if (dir) setReveal({ path: dir });
      setNonce((n) => n + 1);
      void refreshSite();
      const desc = [r.replaced ? `${plural(r.replaced, "file")} replaced` : "", r.skipped.length ? `${r.skipped.length} left out (${r.skipped[0]!.path}: ${r.skipped[0]!.reason})` : ""].filter(Boolean).join(". ");
      toast.success(`Unpacked ${plural(r.added + r.replaced, "file")}${dir ? ` into ${dir}` : ""}`, desc ? { description: desc } : undefined);
    } catch (err) {
      toast.error("Couldn't unpack that zip", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- site actions

  const url = site.address?.url ?? null;
  async function rollback(version: string) {
    setBusy(version);
    try {
      await api.post<SiteDetail>(`/api/sites/${id}/rollback`, { version }).then((d) => refreshSite(d, { revalidate: false }));
      toast.success("That version is live again");
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "reauth_cancelled")) toast.error("Couldn't put it live", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }
  async function previewVersion(version: string) {
    const w = window.open("about:blank", "_blank");
    try {
      const p = await api.post<SitePreview>(`/api/sites/${id}/preview`, { version });
      if (w) {
        w.opener = null;
        w.location.href = p.url;
      }
    } catch (err) {
      w?.close();
      toast.error("Couldn't open that version", { description: err instanceof Error ? err.message : undefined });
    }
  }
  function takeOffline() {
    confirm({
      title: `Take ${site.name} offline?`,
      consequences: [`${site.address?.host} stops answering.`, "The address, the draft and the last versions are kept.", "Publishing puts it back."],
      confirmLabel: "Take it offline",
      variant: "danger",
      onConfirm: async () => {
        const d = await api.post<SiteDetail>(`/api/sites/${id}/unpublish`);
        void refreshSite(d, { revalidate: false });
        toast.success(`${site.name} is offline`);
      },
    });
  }
  function deleteSite() {
    confirm({
      title: `Delete ${site.name}?`,
      consequences: [
        ...(site.address ? [`${site.address.host} stops working and comes off the Network page.`] : []),
        ...(site.versions.length ? [`${plural(site.versions.length, "published version")} ${site.versions.length === 1 ? "is" : "are"} deleted.`] : []),
        `The draft (${plural(site.draft.files, "file")}, ${formatBytes(site.draft.bytes)}) is deleted.`,
        "This can't be undone. Download it as a .zip first if you might want it back.",
      ],
      typeToConfirm: site.address ? site.name : undefined,
      confirmLabel: "Delete site",
      variant: "dangerSolid",
      onConfirm: async () => {
        await api.del(`/api/sites/${id}`);
        setBuffers({});
        toast.success(`Deleted ${site.name}`);
        router.push("/sites");
      },
    });
  }

  const copy = () => url && void copyText(url).then((ok) => (ok ? toast.success("Address copied", { description: url.replace(/^https?:\/\//, "") }) : toast.error("Couldn't copy", { description: url })));

  // ---------------------------------------------------------------- layout

  // Wide: files, editor and preview side by side. Tablet: files plus the editor or the preview. Phone: one at a time.
  const show = (p: Pane) => (wide ? true : phone ? pane === p : p === "files" || p === (pane === "files" ? "code" : pane));
  const publishLabel = site.state === "live" ? "Publish changes" : site.state === "off" ? "Publish again" : "Publish";
  // Nothing new to put live: the draft matches it and nothing is waiting to be saved.
  const upToDate = site.state === "live" && !site.changes && !dirtyPaths.length;

  const codeArea = (
    <section className={e.codeArea} aria-label="Editor" data-hidden={show("code") ? undefined : ""}>
      <div className={e.paneBar}>
        <span className={e.filePath} title={path ?? undefined}>
          {path ?? "No file open"}
          {dirty && <span className={e.dirtyText}>Not saved</span>}
        </span>
        {buf && (
          <Button size="sm" variant={dirty ? "secondary" : "ghost"} onClick={() => void save()} loading={saving} disabled={!dirty} iconEnd={dirty ? <span className={e.kbd}><Kbd>{mac ? "⌘S" : "Ctrl S"}</Kbd></span> : undefined}>
            {dirty ? "Save" : "Saved"}
          </Button>
        )}
      </div>
      {conflict && conflict.path === path && (
        <div className={e.conflict}>
          <Notice tone="attention" title={conflict.kind === "changed" ? "This file changed somewhere else" : "This file isn't in the draft any more"}>
            {conflict.kind === "changed" ? "It was saved from another tab or by someone else after you opened it. Load that version (your edits here are dropped), or keep yours and save over it." : "It was deleted or renamed somewhere else. Save your copy to put it back, or open another file."}
            <span className={e.conflictActions}>
              {conflict.kind === "changed" ? (
                <>
                  <Button size="sm" onClick={() => void load(conflict.path, true)}>
                    Load that version
                  </Button>
                  <Button size="sm" onClick={() => void save(conflict.path, { force: true })}>
                    Keep mine
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => void save(conflict.path, { asNew: true })}>
                  Save it again
                </Button>
              )}
            </span>
          </Notice>
        </div>
      )}
      <div className={e.codeBody}>
        {loadError ? (
          <div className={e.stagePad}>
            <Notice tone="fault" title={`Couldn't open ${path}`} action={<Button size="sm" onClick={() => path && void load(path, true)}>Try again</Button>}>
              {loadError}
            </Notice>
          </div>
        ) : !path ? (
          <div className={e.nothing}>
            <p>{tree?.files.length ? "Pick a file to edit it." : "This site has no files yet."}</p>
            <span className={e.nothingActions}>
              <Button size="sm" icon={<PagePlus />} onClick={() => setAsk({ kind: "new-file", dir: "" })}>
                New file
              </Button>
              <Menu
                trigger={
                  <Button size="sm" icon={<Upload />}>
                    Upload
                  </Button>
                }
                items={uploadEntries("", onTreeAction)}
                align="start"
              />
            </span>
          </div>
        ) : isImage(path) && !path.toLowerCase().endsWith(".svg") ? (
          <figure className={e.image}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${fileUrl(id, path)}&v=${tree?.files.find((f) => f.path === path)?.mtime ?? 0}`} alt={path.split("/").pop()} />
            <figcaption className="num">
              {path.split("/").pop()} · {formatBytes(tree?.files.find((f) => f.path === path)?.size ?? 0)}
            </figcaption>
          </figure>
        ) : other?.kind === "binary" && other.path === path ? (
          <div className={e.nothing}>
            <p>{other.reason === "too-large" ? `${path.split("/").pop()} is ${formatBytes(other.size)}, too big to edit here.` : `${path.split("/").pop()} isn't a text file, so it can't be edited here.`}</p>
            <span className={e.nothingActions}>
              <Button size="sm" icon={<Download />} onClick={() => (window.location.href = fileUrl(id, path, true))}>
                Download it
              </Button>
            </span>
          </div>
        ) : buf ? (
          <CodePane
            docKey={`${path}:${buf.key}`}
            value={buf.text}
            language={languageOf(path)}
            label={`Contents of ${path}`}
            onChange={(text) => setBuffers((all) => (all[path] ? { ...all, [path]: { ...all[path]!, text } } : all))}
            onSave={() => void save(path)}
          />
        ) : loading ? (
          <div className={e.stagePad}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} height={12} width={`${[62, 80, 45, 70, 30, 85, 55, 40][i]}%`} style={{ margin: "10px 0" }} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );

  return (
    <Page>
      <PageHeader
        back={{ href: "/sites", label: "Sites" }}
        title={site.name}
        summary={sentence(site, dirtyPaths.length)}
        actions={
          <>
            {site.state === "live" && url && (
              <a className={buttonClass({ variant: "ghost" })} href={url} target="_blank" rel="noopener noreferrer">
                <OpenNewWindow />
                <span>Open the site</span>
              </a>
            )}
            <Button variant="primary" icon={<Internet />} onClick={() => setAsk({ kind: "publish" })} disabled={!tree || upToDate}>
              {publishLabel}
            </Button>
            <Menu
              trigger={
                <IconButton label="More for this site">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                ...(url ? [{ label: "Copy address", icon: <Copy />, onSelect: copy }] : []),
                { label: "Download as .zip", icon: <Download />, onSelect: () => (window.location.href = `/api/sites/${id}/zip`) },
                { label: "Rename site", icon: <EditPencil />, onSelect: () => setAsk({ kind: "rename-site" }) },
                ...(site.address ? [{ label: "Change the address", icon: <Internet />, onSelect: () => setAsk({ kind: "publish", address: true }) }] : []),
                "separator" as const,
                ...(site.state === "live" ? [{ label: "Take offline", icon: <Prohibition />, onSelect: takeOffline }] : []),
                { label: "Delete site", icon: <Trash />, danger: true, onSelect: deleteSite },
              ]}
            />
          </>
        }
      />

      {site.versions.length > 0 && <VersionStrip site={site} busy={busy} onPreview={(v) => void previewVersion(v)} onRollback={rollback} />}

      {!wide && (
        <div className={e.paneSwitch}>
          <Segmented
            value={phone ? pane : pane === "files" ? "code" : pane}
            onChange={setPane}
            aria-label="Show"
            block
            options={[...(phone ? [{ value: "files" as Pane, label: "Files" }] : []), { value: "code" as Pane, label: dirty ? "Edit (not saved)" : "Edit" }, { value: "preview" as Pane, label: "Preview" }]}
          />
        </div>
      )}

      <div className={e.workspace} data-layout={wide ? "wide" : phone ? "phone" : "mid"}>
        <aside className={e.files} aria-label="Files" data-hidden={show("files") ? undefined : ""}>
          <div className={e.paneBar}>
            <span className={e.barTitle}>Files</span>
            <span className={e.barTools}>
              <IconButton label="New file" size="sm" onClick={() => setAsk({ kind: "new-file", dir: path ? parentOf(path) : "" })}>
                <PagePlus />
              </IconButton>
              <IconButton label="New folder" size="sm" onClick={() => setAsk({ kind: "new-folder", dir: "" })}>
                <FolderPlus />
              </IconButton>
              <Menu
                trigger={
                  <IconButton label="Upload" size="sm" loading={busy === "zip"}>
                    <Upload />
                  </IconButton>
                }
                items={uploadEntries("", onTreeAction)}
              />
            </span>
          </div>
          <FileTree
            tree={tree}
            selected={path}
            dirty={dirtySet}
            onOpen={open}
            onAction={onTreeAction}
            reveal={reveal}
            onDrop={(dir, dt) => void fromDrop(dt, dir).then((items) => sendFiles(items, dir))}
            footer={
              upload ? (
                <div className={e.uploading} aria-live="polite">
                  <span className="num">
                    Uploading {Math.min(upload.done + 1, upload.total)} of {upload.total}
                  </span>
                  <UsageBar value={upload.bytesTotal ? upload.bytesDone : upload.done} max={upload.bytesTotal || upload.total} label="Upload progress" />
                </div>
              ) : tree ? (
                <p className={`${e.treeFoot} num`}>
                  {plural(tree.files.length, "file")} · {formatBytes(tree.bytes)}
                </p>
              ) : null
            }
          />
        </aside>
        {codeArea}
        <section className={e.previewArea} aria-label="Preview" data-hidden={show("preview") ? undefined : ""}>
          <PreviewPane preview={preview} error={previewError} page={page} pages={pages} onPage={setPage} nonce={nonce} onReload={() => setNonce((n) => n + 1)} />
        </section>
      </div>

      <input ref={filesRef} type="file" multiple hidden onChange={(ev) => (void sendFiles(fromInput(ev.target.files, uploadDir.current), uploadDir.current), (ev.target.value = ""))} />
      <input ref={folderRef} type="file" hidden {...({ webkitdirectory: "" } as object)} onChange={(ev) => (void sendFiles(fromInput(ev.target.files, uploadDir.current), uploadDir.current), (ev.target.value = ""))} />
      <input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={(ev) => (ev.target.files?.[0] && void sendZip(ev.target.files[0], uploadDir.current), (ev.target.value = ""))} />

      {ask?.kind === "new-file" && (
        <NameDialog
          open
          onOpenChange={(o) => !o && setAsk(null)}
          title="New file"
          label="Name"
          initial={tree?.files.length ? "page.html" : "index.html"}
          selectStem
          prefix={ask.dir || undefined}
          confirmLabel="Make the file"
          onSubmit={async (name) => {
            const p = join(ask.dir, name);
            const text = blankFor(p, site.name);
            const r = await api.put<{ etag: string; tree: SiteTree }>(`/api/sites/${id}/file`, { path: p, text, etag: null });
            applyTree(r.tree);
            setBuffers((all) => ({ ...all, [p]: { file: { path: p, kind: "text", text, etag: r.etag, size: new Blob([text]).size }, text, key: 1 } }));
            open(p);
          }}
        />
      )}
      {ask?.kind === "new-folder" && (
        <NameDialog open onOpenChange={(o) => !o && setAsk(null)} title="New folder" label="Name" initial="" prefix={ask.dir || undefined} confirmLabel="Make the folder" onSubmit={async (name) => {
            await op({ op: "mkdir", path: join(ask.dir, name) });
            setReveal({ path: join(ask.dir, name) });
          }} />
      )}
      {ask?.kind === "rename" && (
        <NameDialog
          open
          onOpenChange={(o) => !o && setAsk(null)}
          title={`Rename ${ask.path.split("/").pop()}`}
          label="New name"
          initial={ask.path.split("/").pop()!}
          selectStem={!ask.dir}
          prefix={parentOf(ask.path) || undefined}
          confirmLabel="Rename"
          onSubmit={(name) => rename(ask.path, join(parentOf(ask.path), name))}
        />
      )}
      {ask?.kind === "move" && <MoveDialog open onOpenChange={(o) => !o && setAsk(null)} path={ask.path} isDir={ask.dir} dirs={tree?.dirs ?? []} onSubmit={(to) => rename(ask.path, to)} />}
      {ask?.kind === "rename-site" && (
        <NameDialog
          open
          onOpenChange={(o) => !o && setAsk(null)}
          title="Rename site"
          label="Name"
          initial={site.name}
          confirmLabel="Rename"
          validate={(n) => (!n ? "Give the site a name." : n.length > 60 ? "Keep the name under 60 characters." : null)}
          onSubmit={async (name) => void refreshSite(await api.patch<SiteDetail>(`/api/sites/${id}`, { name }), { revalidate: false })}
        />
      )}
      {ask?.kind === "publish" && (
        <PublishDialog
          site={site}
          open
          onOpenChange={(o) => !o && setAsk(null)}
          changeAddress={ask.address}
          hasIndex={hasIndex}
          unsavedFile={dirtyPaths.length === 1 ? dirtyPaths[0]! : dirtyPaths.length ? plural(dirtyPaths.length, "file") : null}
          beforePublish={saveAll}
          onPublished={(d) => void refreshSite(d, { revalidate: false })}
        />
      )}
      {confirmNode}
    </Page>
  );
}
