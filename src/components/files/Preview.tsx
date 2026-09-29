"use client";
import * as React from "react";
import { Download, EditPencil, NavArrowLeft, NavArrowRight, Archive } from "iconoir-react";
import type { FileEntry, TextFile } from "@/lib/files-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog, useConfirm, type ConfirmOptions } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { CodeEditor } from "@/components/code/CodeEditor";
import { Segmented } from "@/components/ui/Field";
import { Markdown } from "./Markdown";
import type { CodeLanguage } from "@/components/code/languages";
import { KIND_LABEL, KindIcon, THUMBABLE, downloadUrl, isArchive, rawUrl, thumbUrl, useMediaQuery } from "./lib";
import s from "./files.module.css";

interface Props {
  entry: FileEntry | null;
  /** Files in the same folder, in listing order, for previous/next. */
  siblings: FileEntry[];
  onNavigate: (e: FileEntry) => void;
  onClose: () => void;
  canWrite: boolean;
  onExtract?: (e: FileEntry) => void;
  onSaved?: () => void;
}

export function Preview({ entry, siblings, onNavigate, onClose, canWrite, onExtract, onSaved }: Props) {
  const fmt = useFormat();
  const [dirty, setDirty] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const discard = React.useCallback(
    (then: () => void) => {
      if (!dirty) return then();
      confirm({
        title: "Discard your edits?",
        consequences: ["Your changes to this file haven't been saved and will be lost."],
        confirmLabel: "Discard edits",
        onConfirm: () => {
          setDirty(false);
          then();
        },
      });
    },
    [dirty, confirm],
  );
  const idx = entry ? siblings.findIndex((x) => x.path === entry.path) : -1;
  const prev = idx > 0 ? siblings[idx - 1] : undefined;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : undefined;

  const go = React.useCallback(
    (e: FileEntry | undefined) => {
      if (!e) return;
      discard(() => onNavigate(e));
    },
    [discard, onNavigate],
  );

  const close = React.useCallback(() => discard(onClose), [discard, onClose]);

  // Quick Look keys: ← and → step through the folder, Space closes (as it opened). Not while typing,
  // in the text editor, or on a player's own controls.
  React.useEffect(() => {
    if (!entry) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if ((ev.target as HTMLElement)?.closest("input,textarea,select,video,audio,button,[contenteditable],[role=menu]")) return;
      if (ev.key === "ArrowLeft") go(prev);
      else if (ev.key === "ArrowRight") go(next);
      else if (ev.key === " ") close();
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, prev, next, go, close]);

  const phone = useMediaQuery("(max-width: 640px)");
  const swipe = React.useRef<{ x: number; y: number } | null>(null);

  if (!entry) return null;
  const nav = siblings.length > 1 && idx >= 0;
  const download = (
    <Button icon={<Download />} onClick={() => downloadUrl(rawUrl(entry.path, true))}>
      Download
    </Button>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      size="xwide"
      title={<span className="truncate" title={entry.name} style={{ display: "block" }}>{entry.name}</span>}
      description={
        <span className="num">
          {KIND_LABEL[entry.kind]}
          {entry.size !== null && ` · ${fmt.bytes(entry.size)}`} · modified <Time ts={entry.mtime} />
        </span>
      }
      footerStart={
        siblings.length > 1 && idx >= 0 ? (
          <span className={s.previewNav}>
            <IconButton label="Previous" size="sm" disabled={!prev} onClick={() => go(prev)} shortcut="←">
              <NavArrowLeft />
            </IconButton>
            <span className="num muted">
              {idx + 1} of {siblings.length}
            </span>
            <IconButton label="Next" size="sm" disabled={!next} onClick={() => go(next)} shortcut="→">
              <NavArrowRight />
            </IconButton>
          </span>
        ) : undefined
      }
      footer={
        phone && nav ? (
          // Phones hide the footer's left side, so the arrows sit either side of Download.
          <span className={s.previewPhoneFoot}>
            <IconButton label="Previous" disabled={!prev} onClick={() => go(prev)}>
              <NavArrowLeft />
            </IconButton>
            {download}
            <IconButton label="Next" disabled={!next} onClick={() => go(next)}>
              <NavArrowRight />
            </IconButton>
          </span>
        ) : (
          download
        )
      }
    >
      <div
        className={s.previewBody}
        key={entry.path}
        // Swipe sideways through photos and videos on a touch screen.
        onTouchStart={(e) => {
          const t = e.touches[0];
          swipe.current = entry.preview === "text" || e.touches.length > 1 || !t ? null : { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const st = swipe.current;
          const t = e.changedTouches[0];
          swipe.current = null;
          if (!st || !t) return;
          const dx = t.clientX - st.x;
          if (Math.abs(dx) > 60 && Math.abs(t.clientY - st.y) < 50) go(dx < 0 ? next : prev);
        }}
      >
        {entry.preview === "image" && <ImagePreview entry={entry} />}
        {entry.preview === "video" && (
          <video className={s.previewMedia} src={rawUrl(entry.path)} controls autoPlay playsInline preload="metadata">
            Your browser can't play this video. Download it instead.
          </video>
        )}
        {entry.preview === "audio" && (
          <div className={s.previewAudio}>
            <KindIcon kind="audio" className={s.previewGlyph} />
            <audio src={rawUrl(entry.path)} controls autoPlay preload="metadata" style={{ width: "100%" }} />
          </div>
        )}
        {entry.preview === "pdf" && <iframe className={s.previewFrame} src={rawUrl(entry.path)} title={entry.name} />}
        {entry.preview === "text" && <TextPreview entry={entry} canWrite={canWrite} onDirty={setDirty} onSaved={onSaved} confirm={confirm} />}
        {entry.preview === null && (
          <div className={s.previewFallback}>
            <KindIcon kind={entry.kind} type={entry.type} className={s.previewGlyph} />
            <p className={s.previewFallbackTitle}>Gluon can't show {entry.kind === "other" ? "this kind of file" : `${KIND_LABEL[entry.kind].toLowerCase()} files like this one`} in the browser.</p>
            <p className="muted">
              {entry.kind === "video"
                ? "Open it in Jellyfin or another player, or download it to watch with VLC."
                : entry.kind === "disk-image"
                  ? "Disk images are used to install systems or run virtual machines. Download it to use it."
                  : entry.kind === "archive"
                    ? "Extract it to see what's inside, or download it."
                    : "Download it and open it with an app on your device."}
            </p>
            <div className={s.previewFallbackActions}>
              <Button variant="primary" icon={<Download />} onClick={() => downloadUrl(rawUrl(entry.path, true))}>
                Download {fmt.bytes(entry.size ?? 0)}
              </Button>
              {isArchive(entry.name) && canWrite && onExtract && (
                <Button icon={<Archive />} onClick={() => onExtract(entry)}>
                  Extract here
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {confirmNode}
    </Dialog>
  );
}

/**
 * A photo fitted to the window, with its real size once it loads; click (or Enter) to see it at
 * full size and scroll around, click again to fit. A thumbnail shows while the original loads.
 */
function ImagePreview({ entry }: { entry: FileEntry }) {
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  const [actual, setActual] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const fits = size ? size.w <= 1100 && size.h <= 760 : false;
  if (failed) {
    return (
      <div className={s.previewFallback}>
        <KindIcon kind="image" className={s.previewGlyph} />
        <p className={s.previewFallbackTitle}>Your browser can't show this image.</p>
        <p className="muted">Download it and open it with an app on your device.</p>
      </div>
    );
  }
  return (
    <div className={s.imageStage} data-actual={actual ? "" : undefined}>
      <button
        type="button"
        className={s.imageButton}
        onClick={() => !fits && setActual((a) => !a)}
        aria-label={actual ? "Fit to the window" : fits ? entry.name : "Show at full size"}
        disabled={!size || fits}
        style={size && !actual ? { aspectRatio: `${size.w} / ${size.h}` } : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={s.previewImage}
          src={rawUrl(entry.path)}
          alt={entry.name}
          style={thumbBg(entry)}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      </button>
      {size && (
        <span className={`${s.imageSize} num`}>
          {size.w.toLocaleString()} × {size.h.toLocaleString()}
          {!fits && <> · {actual ? "full size" : "fitted"}</>}
        </span>
      )}
    </div>
  );
}

function thumbBg(entry: FileEntry): React.CSSProperties | undefined {
  return THUMBABLE.test(entry.name) ? { backgroundImage: `url("${thumbUrl(entry, 480)}")`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : undefined;
}

function langOf(t: TextFile | undefined): CodeLanguage {
  return (t?.language as CodeLanguage | null) ?? "text";
}

function TextPreview({ entry, canWrite, onDirty, onSaved, confirm }: { entry: FileEntry; canWrite: boolean; onDirty: (d: boolean) => void; onSaved?: () => void; confirm: (o: ConfirmOptions) => void }) {
  const fmt = useFormat();
  const { data, error, isLoading, mutate } = useApi<TextFile>(`/api/files/text?path=${encodeURIComponent(entry.path)}`, { keepPreviousData: false, revalidateOnFocus: false });
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<{ mtime: number } | null>(null);
  const isMarkdown = data?.language === "markdown" || /\.(md|markdown|mdown)$/i.test(entry.name);
  const [mode, setMode] = React.useState<"read" | "source">("read");
  const dirty = editing && draft !== (data?.content ?? "");
  React.useEffect(() => onDirty(dirty), [dirty, onDirty]);

  async function save(force = false) {
    if (!data) return;
    setSaving(true);
    try {
      const r = await api.put<{ mtime: number; size: number }>("/api/files/text", { path: data.path, content: draft, expectedMtime: force ? null : data.mtime });
      await mutate({ ...data, content: draft, mtime: r.mtime, size: r.size }, { revalidate: false });
      setConflict(null);
      setEditing(false);
      toast.success(`Saved ${entry.name}`);
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === "changed") setConflict({ mtime: Number(e.details?.mtime ?? 0) });
      else toast.error(`Couldn't save ${entry.name}`, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <Notice tone="fault" title="Can't open this file">
        {error.message}
      </Notice>
    );
  }
  if (isLoading || !data) return <Skeleton height={420} radius={10} />;
  if (data.encoding === "binary" || data.content === null) {
    return (
      <div className={s.previewFallback}>
        <KindIcon kind={entry.kind} className={s.previewGlyph} />
        <p className={s.previewFallbackTitle}>This file isn't text.</p>
        <p className="muted">Download it and open it with an app that understands it.</p>
      </div>
    );
  }
  const reading = isMarkdown && mode === "read" && !editing;
  // Fit short files instead of framing three lines in a tall empty box.
  const lines = (editing ? draft : (data.content ?? "")).split("\n").length;
  const height = `min(62dvh, ${Math.max(6, Math.min(lines, 40)) * 19 + 18}px)`;
  return (
    <div className={s.textPreview}>
      <div className={s.textBar}>
        {isMarkdown && !editing && (
          <Segmented
            aria-label="Show as"
            value={mode}
            onChange={setMode}
            options={[
              { value: "read", label: "Formatted" },
              { value: "source", label: "Source" },
            ]}
          />
        )}
        <span className="muted num">
          {data.encoding.toUpperCase()}
          {data.truncated && ` · showing the first ${fmt.bytes(1024 * 1024)}`}
          {!data.editable && canWrite && data.readOnlyReason ? ` · ${data.readOnlyReason}` : ""}
        </span>
        <span className={s.spacer} />
        {editing ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                const stop = () => {
                  setEditing(false);
                  setConflict(null);
                };
                if (!dirty) return stop();
                confirm({ title: "Discard your edits?", consequences: ["Your changes to this file haven't been saved and will be lost."], confirmLabel: "Discard edits", onConfirm: stop });
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </>
        ) : (
          data.editable && (
            <Button
              size="sm"
              icon={<EditPencil />}
              onClick={() => {
                setDraft(data.content ?? "");
                setEditing(true);
                setMode("source");
              }}
            >
              Edit
            </Button>
          )
        )}
      </div>
      {conflict && (
        <Notice
          tone="attention"
          title="Someone else changed this file"
          action={
            <span style={{ display: "flex", gap: 6 }}>
              <Button
                size="sm"
                onClick={() => {
                  setConflict(null);
                  setEditing(false);
                  void mutate();
                }}
              >
                Load their version
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save(true)} loading={saving}>
                Save mine anyway
              </Button>
            </span>
          }
        >
          It was changed <Time ts={conflict.mtime} /> — after you opened it. Saving yours replaces those changes.
        </Notice>
      )}
      {reading ? (
        <div className={s.readPane}>
          <Markdown source={data.content ?? ""} />
        </div>
      ) : (
        <CodeEditor
          key={`${editing}`}
          label={`Contents of ${entry.name}`}
          value={editing ? draft : (data.content ?? "")}
          onChange={editing ? setDraft : undefined}
          readOnly={!editing}
          language={langOf(data)}
          height={height}
        />
      )}
    </div>
  );
}
