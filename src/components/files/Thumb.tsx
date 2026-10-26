"use client";
import * as React from "react";
import type { FileEntry, FileKind } from "@/lib/files-types";
import { FolderGlyph, KindIcon, POSTERABLE, THUMBABLE, rawUrl, thumbUrl, useVideoPoster } from "./lib";
import s from "./look.module.css";

export interface ThumbItem {
  path: string;
  name: string;
  kind: FileKind;
  type: FileEntry["type"];
  size: number | null;
  mtime: number;
}

function extOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return null;
  const x = name.slice(i + 1);
  return x.length <= 5 ? x.toUpperCase() : null;
}

/**
 * The face of an item at any size: a thumbnail for photos, a still frame for playable video, the
 * drawn folder, or the kind's glyph with its extension. `cover` is an image to show instead (a
 * film's poster, a show's or an album's cover found beside it).
 */
export function Thumb(props: ThumbProps) {
  // Keyed by path: a recycled row (virtual lists, re-sorts) must not keep another file's loaded or failed state.
  return <ThumbFace key={props.item.path} {...props} />;
}

interface ThumbProps {
  item: ThumbItem;
  size?: number;
  cover?: string | null;
  className?: string;
}

function ThumbFace({ item, size = 320, cover, className }: ThumbProps) {
  const dir = item.kind === "folder";
  const image = !dir && THUMBABLE.test(item.name);
  const video = !dir && !cover && POSTERABLE.test(item.name);
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const poster = useVideoPoster(video ? `${item.path}:${item.mtime}` : null, rawUrl(item.path));
  let face: React.ReactNode;
  if (cover) {
    // eslint-disable-next-line @next/next/no-img-element
    face = <img className={s.thumbImg} data-loaded={loaded ? "" : undefined} src={cover} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} />;
  } else if (dir) {
    face = <FolderGlyph className={s.thumbFolder} link={item.type === "symlink"} />;
  } else if (image && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    face = <img className={s.thumbImg} data-loaded={loaded ? "" : undefined} src={thumbUrl(item, size)} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />;
  } else if (video && poster) {
    // eslint-disable-next-line @next/next/no-img-element
    face = <img className={s.thumbImg} data-loaded="" src={poster} alt="" />;
  } else {
    const ext = extOf(item.name);
    face = (
      <span className={s.thumbKind}>
        <KindIcon kind={item.kind} type={item.type} className={s.thumbGlyph} />
        {ext && <span className={s.thumbExt}>{ext}</span>}
      </span>
    );
  }
  return (
    <span className={`${s.thumb} ${className ?? ""}`} data-kind={item.kind} data-photo={image && !failed ? "" : undefined}>
      {face}
    </span>
  );
}
