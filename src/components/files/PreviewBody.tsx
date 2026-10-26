"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import { Archive, Download } from "iconoir-react";
import type { FileEntry, TextFile } from "@/lib/files-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import type { CodeLanguage } from "@/components/code/languages";
import { Markdown } from "./Markdown";
import { KIND_LABEL, KindIcon, THUMBABLE, downloadUrl, isArchive, isDirLike, rawUrl, thumbUrl } from "./lib";
import s from "./look.module.css";

const CodeEditor = dynamic(() => import("@/components/code/CodeEditor").then((m) => m.CodeEditor), { ssr: false, loading: () => <Skeleton height={240} radius={8} /> });

/**
 * What a file looks like, at whatever size the surface gives it: a photo fitted to the box, a
 * player, a PDF, text or a formatted README, or a plain explanation and a download for the rest.
 */
export function PreviewBody({ entry, fit = "contain", textHeight = "min(56dvh, 520px)", canExtract, onExtract }: { entry: FileEntry; fit?: "contain" | "cover"; textHeight?: string; canExtract?: boolean; onExtract?: (e: FileEntry) => void }) {
  const fmt = useFormat();
  if (entry.link?.broken) {
    return (
      <div className={s.fallback}>
        <KindIcon kind={entry.kind} type={entry.type} className={s.fallbackGlyph} />
        <p className={s.fallbackTitle}>This link is broken</p>
        <p className={s.fallbackText}>
          It points to <span className="mono">{entry.link.target}</span>, which doesn't exist any more.
        </p>
      </div>
    );
  }
  switch (entry.preview) {
    case "image":
      return <ImageView entry={entry} fit={fit} />;
    case "video":
      return (
        <video key={entry.path} className={s.media} src={rawUrl(entry.path)} controls playsInline preload="metadata">
          Your browser can't play this video. Download it instead.
        </video>
      );
    case "audio":
      return (
        <div className={s.audio}>
          <KindIcon kind="audio" className={s.fallbackGlyph} />
          <audio key={entry.path} src={rawUrl(entry.path)} controls preload="metadata" />
        </div>
      );
    case "pdf":
      return <iframe key={entry.path} className={s.frame} src={rawUrl(entry.path)} title={entry.name} />;
    case "text":
      return <TextView entry={entry} height={textHeight} />;
    default:
      return (
        <div className={s.fallback}>
          <KindIcon kind={entry.kind} type={entry.type} className={s.fallbackGlyph} />
          <p className={s.fallbackTitle}>{entry.kind === "other" ? "Gluon can't show this kind of file." : `Gluon can't show ${KIND_LABEL[entry.kind].toLowerCase()} files like this one.`}</p>
          <p className={s.fallbackText}>
            {entry.kind === "video"
              ? "Open it in Jellyfin or another player, or download it to watch with VLC."
              : entry.kind === "disk-image"
                ? "Disk images install systems or run virtual machines. Download it to use it."
                : entry.kind === "archive"
                  ? "Extract it to see what's inside, or download it."
                  : "Download it and open it with an app on your device."}
          </p>
          <div className={s.fallbackActions}>
            <Button icon={<Download />} onClick={() => downloadUrl(rawUrl(entry.path, true))}>
              Download {fmt.bytes(entry.size ?? 0)}
            </Button>
            {isArchive(entry.name) && canExtract && onExtract && (
              <Button icon={<Archive />} onClick={() => onExtract(entry)}>
                Extract here
              </Button>
            )}
          </div>
        </div>
      );
  }
}

function ImageView({ entry, fit }: { entry: FileEntry; fit: "contain" | "cover" }) {
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setSize(null);
    setFailed(false);
  }, [entry.path]);
  if (failed) {
    return (
      <div className={s.fallback}>
        <KindIcon kind="image" className={s.fallbackGlyph} />
        <p className={s.fallbackTitle}>Your browser can't show this image.</p>
        <p className={s.fallbackText}>Download it and open it with an app on your device.</p>
      </div>
    );
  }
  return (
    <figure className={s.imageStage} data-fit={fit}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={entry.path}
        className={s.image}
        src={rawUrl(entry.path)}
        alt={entry.name}
        style={THUMBABLE.test(entry.name) ? { backgroundImage: `url("${thumbUrl(entry, 480)}")` } : undefined}
        onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
      />
      {size && (
        <figcaption className={`${s.imageSize} num`}>
          {size.w.toLocaleString()} × {size.h.toLocaleString()}
        </figcaption>
      )}
    </figure>
  );
}

function TextView({ entry, height }: { entry: FileEntry; height: string }) {
  const fmt = useFormat();
  const { data, error } = useApi<TextFile>(`/api/files/text?path=${encodeURIComponent(entry.path)}`, { keepPreviousData: false, revalidateOnFocus: false });
  if (error) {
    return (
      <Notice tone="fault" title="Can't open this file">
        {error.message}
      </Notice>
    );
  }
  if (!data) return <Skeleton height={240} radius={8} />;
  if (data.encoding === "binary" || data.content === null) {
    return (
      <div className={s.fallback}>
        <KindIcon kind={entry.kind} className={s.fallbackGlyph} />
        <p className={s.fallbackTitle}>This file isn't text.</p>
        <p className={s.fallbackText}>Download it and open it with an app that understands it.</p>
      </div>
    );
  }
  const markdown = data.language === "markdown" || /\.(md|markdown|mdown)$/i.test(entry.name);
  return (
    <div className={s.text}>
      {markdown ? (
        <div className={s.read} style={{ maxHeight: height }}>
          <Markdown source={data.content} />
        </div>
      ) : (
        <CodeEditor label={`Contents of ${entry.name}`} value={data.content} readOnly language={(data.language as CodeLanguage | null) ?? "text"} height={height} />
      )}
      {data.truncated && <p className={`${s.textNote} num`}>Showing the first {fmt.bytes(1024 * 1024)}.</p>}
    </div>
  );
}

/** The plain facts about an item, owner and permissions only for admins (they mean nothing to others). */
export function Facts({ entry, admin, extra }: { entry: FileEntry; admin: boolean; extra?: [React.ReactNode, React.ReactNode][] }) {
  const fmt = useFormat();
  const dir = isDirLike(entry);
  const rows: [React.ReactNode, React.ReactNode][] = [
    ["Kind", entry.type === "symlink" ? `Link to a ${dir ? "folder" : KIND_LABEL[entry.kind].toLowerCase()}` : KIND_LABEL[entry.kind]],
    ["Size", dir ? (entry.dirSize ? <span className="num">{fmt.bytes(entry.dirSize.bytes)}</span> : <span className="muted">Not measured</span>) : <span className="num">{fmt.bytes(entry.size)}</span>],
    ["Modified", <Time key="m" ts={entry.mtime} kind="dateTime" />],
    ...(extra ?? []),
    ...(admin
      ? ([
          ["Owner", <span key="o" className="mono">{entry.owner ?? entry.uid}:{entry.group ?? entry.gid}</span>],
          ["Permissions", <span key="p" className="mono">{entry.mode}</span>],
        ] as [React.ReactNode, React.ReactNode][])
      : []),
  ];
  return (
    <div className={s.facts}>
      <dl className={s.factList}>
        {rows.map(([k, v], i) => (
          <React.Fragment key={i}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div className={s.factPath}>
        <span className="mono" title={entry.path}>
          {entry.path}
        </span>
        <CopyButton value={entry.path} label="Copy path" />
      </div>
    </div>
  );
}

/**
 * The size rule: a hairline whose length is this item's share of the biggest thing beside it, so
 * what's taking the space is visible before any number is read.
 */
export function SizeRule({ share, className }: { share: number | null; className?: string }) {
  if (share === null || !Number.isFinite(share)) return <span className={`${s.rule} ${className ?? ""}`} aria-hidden data-empty="" />;
  return (
    <span className={`${s.rule} ${className ?? ""}`} aria-hidden>
      <span style={{ width: `${Math.max(1.5, Math.min(100, share * 100))}%` }} />
    </span>
  );
}

/** Rename in place: the name is selected without its extension, so typing replaces just the name. */
export function RenameField({ entry, initial, onCommit, onCancel, className }: { entry: FileEntry; initial?: string; onCommit: (name: string) => void; onCancel: () => void; className?: string }) {
  const [value, setValue] = React.useState(initial || entry.name);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (!v || v === entry.name) onCancel();
    else onCommit(v);
  };
  return (
    <input
      className={`${s.rename} ${className ?? ""}`}
      autoFocus
      value={value}
      aria-label={`New name for ${entry.name}`}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      enterKeyHint="done"
      maxLength={255}
      onFocus={(ev) => {
        const name = initial || entry.name;
        const m = isDirLike(entry) || name.startsWith(".") ? null : name.match(/((?:\.tar)?\.[A-Za-z0-9]{1,8})$/);
        ev.currentTarget.setSelectionRange(0, m ? name.length - m[1]!.length : name.length);
      }}
      onChange={(ev) => setValue(ev.target.value)}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
      onClick={(ev) => ev.stopPropagation()}
      onPointerDown={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
    />
  );
}
