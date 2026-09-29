"use client";
import * as React from "react";
import {
  Archive,
  Code,
  Computer,
  Database,
  Folder,
  HardDrive,
  Home,
  Link as LinkIcon,
  MediaImage,
  MediaVideo,
  MediaVideoFolder,
  MusicDoubleNote,
  Page,
  PageEdit,
  Pin,
  Clock,
} from "iconoir-react";
import type { FileEntry, FileKind, Place, SortKey } from "@/lib/files-types";
import type { Prefs } from "@/lib/prefs";

export const rawUrl = (path: string, download = false) => `/api/files/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export const filesHref = (path: string) => `/files?path=${encodeURIComponent(path)}`;
export const thumbUrl = (e: Pick<FileEntry, "path" | "mtime" | "size">, size = 320) => `/api/files/thumb?path=${encodeURIComponent(e.path)}&size=${size}&v=${Math.floor(e.mtime / 1000).toString(36)}-${(e.size ?? 0).toString(36)}`;

export function parentOf(p: string): string {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
export function joinPath(dir: string, name: string) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
export function baseName(p: string) {
  return p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
}

export const isDirLike = (e: Pick<FileEntry, "type" | "link">) => e.type === "dir" || (e.type === "symlink" && e.link?.type === "dir");

const ARCHIVE = /\.(zip|tar|tgz|tbz2?|txz|tzst|7z|rar|gz|xz|bz2|zst)$/i;
export const isArchive = (name: string) => ARCHIVE.test(name);

export function KindIcon({ kind, type, className }: { kind: FileKind; type?: FileEntry["type"]; className?: string }) {
  const props = { className, "aria-hidden": true as const };
  if (kind === "folder") return <Folder {...props} />;
  if (type === "symlink" && kind === "other") return <LinkIcon {...props} />;
  switch (kind) {
    case "image":
      return <MediaImage {...props} />;
    case "video":
      return <MediaVideo {...props} />;
    case "audio":
      return <MusicDoubleNote {...props} />;
    case "document":
      return <PageEdit {...props} />;
    case "archive":
      return <Archive {...props} />;
    case "text":
      return <Code {...props} />;
    case "disk-image":
      return <HardDrive {...props} />;
    default:
      return <Page {...props} />;
  }
}

export function PlaceIcon({ kind, className }: { kind: Place["kind"]; className?: string }) {
  const props = { className, "aria-hidden": true as const };
  switch (kind) {
    case "root":
      return <Computer {...props} />;
    case "drive":
      return <HardDrive {...props} />;
    case "data":
      return <Database {...props} />;
    case "home":
      return <Home {...props} />;
    case "media":
      return <MediaVideoFolder {...props} />;
    case "pin":
      return <Pin {...props} />;
    case "recent":
      return <Clock {...props} />;
    default:
      return <Folder {...props} />;
  }
}

export const KIND_LABEL: Record<FileKind, string> = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
  archive: "Archive",
  text: "Text",
  "disk-image": "Disk image",
  other: "File",
};

/** Saved sort pref → API sort key, with the natural direction for each. */
export function sortFromPref(p: Prefs["filesSort"]): { sort: SortKey; order: "asc" | "desc" } {
  switch (p) {
    case "modified":
      return { sort: "mtime", order: "desc" };
    case "size":
      return { sort: "size", order: "desc" };
    case "kind":
      return { sort: "kind", order: "asc" };
    default:
      return { sort: "name", order: "asc" };
  }
}
export function prefFromSort(s: SortKey): Prefs["filesSort"] {
  return s === "mtime" ? "modified" : s === "size" ? "size" : s === "kind" || s === "type" ? "kind" : "name";
}

/** Trigger a browser download without leaving the page. */
export function downloadUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const DRAG_MIME = "application/x-gluon-paths";

/** Props that make an element accept Gluon items dragged from the listing (move, or copy with ⌥/Ctrl). */
export function useDropTarget(path: string | null, onDrop: (sources: string[], dest: string, copy: boolean) => void, enabled = true) {
  const [over, setOver] = React.useState(false);
  const depth = React.useRef(0);
  if (!path || !enabled) return { over: false, props: {} as React.HTMLAttributes<HTMLElement> };
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_MIME);
  const props: React.HTMLAttributes<HTMLElement> = {
    onDragEnter: (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver: (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? "copy" : "move";
    },
    onDragLeave: (e) => {
      if (!accepts(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDrop: (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      try {
        const sources = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as string[];
        const valid = sources.filter((s) => s !== path && parentOf(s) !== path && !path.startsWith(`${s}/`));
        if (valid.length) onDrop(valid, path, e.altKey || e.ctrlKey);
      } catch {
        /* not ours */
      }
    },
  };
  return { over, props };
}

export function useMediaQuery(q: string) {
  const [m, setM] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

/** Image types the server can make thumbnails of. */
export const THUMBABLE = /\.(jpe?g|png|webp|gif|avif|tiff?|bmp|heic|heif)$/i;
/** Video types browsers can usually decode, so a poster frame can be taken from them. */
export const POSTERABLE = /\.(mp4|m4v|webm|mov|ogv)$/i;

/**
 * The grid's folder: a drawn folder in the hairline language, its tab on the left, with an optional
 * second sheet peeking out when it holds something (we don't count children, so it's drawn open
 * only for links and shared roots). Scales with the tile.
 */
export function FolderGlyph({ className, link }: { className?: string; link?: boolean }) {
  return (
    <svg viewBox="0 0 64 52" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M4 10.5A3.5 3.5 0 0 1 7.5 7h14.2a3 3 0 0 1 2.3 1.1l3.2 3.8a3 3 0 0 0 2.3 1.1h27a3.5 3.5 0 0 1 3.5 3.5v27A3.5 3.5 0 0 1 56.5 47h-49A3.5 3.5 0 0 1 4 43.5z" />
      <path d="M4 19h56" opacity="0.55" />
      {link && <path d="M26 34h12m-4-4 4 4-4 4" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

// ---------------------------------------------------------------- video posters

const posters = new Map<string, string | null>();
const posterWaiters = new Map<string, ((v: string | null) => void)[]>();
let posterActive = 0;
const posterQueue: (() => void)[] = [];

function takePoster(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 12_000);
    v.muted = true;
    v.preload = "metadata";
    v.playsInline = true;
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      v.currentTime = d > 30 ? Math.min(d * 0.12, 90) : d * 0.3;
    };
    v.onseeked = () => {
      try {
        const w = 360;
        const h = v.videoHeight && v.videoWidth ? Math.round((w * v.videoHeight) / v.videoWidth) : 202;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL("image/jpeg", 0.72));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}

/**
 * A still frame from a video, taken in the browser (the server has no ffmpeg): at most two at a
 * time, remembered for the session, so scrolling a movie folder doesn't re-read files.
 */
export function useVideoPoster(key: string | null, url: string): string | null {
  const [src, setSrc] = React.useState<string | null>(() => (key ? (posters.get(key) ?? null) : null));
  React.useEffect(() => {
    if (!key) return;
    if (posters.has(key)) {
      setSrc(posters.get(key) ?? null);
      return;
    }
    let live = true;
    const got = (v: string | null) => live && setSrc(v);
    const waiting = posterWaiters.get(key);
    if (waiting) {
      waiting.push(got);
      return () => {
        live = false;
      };
    }
    posterWaiters.set(key, [got]);
    const run = () => {
      posterActive++;
      void takePoster(url).then((v) => {
        posters.set(key, v);
        posterWaiters.get(key)?.forEach((f) => f(v));
        posterWaiters.delete(key);
        posterActive--;
        posterQueue.shift()?.();
      });
    };
    if (posterActive < 2) run();
    else posterQueue.push(run);
    return () => {
      live = false;
    };
  }, [key, url]);
  return src;
}

/** "⌘" on Apple devices, "Ctrl+" elsewhere, for shortcut hints in menus (menus render on the client only). */
export function modKey(): string {
  if (typeof navigator === "undefined") return "Ctrl+";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";
}
