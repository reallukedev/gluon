"use client";
import * as React from "react";
import s from "./appIcon.module.css";

/** An app's icon from its CasaOS/selfh.st URL, falling back to a lettered tile if it fails to load. */
export function AppIcon({ src, name, size = 32 }: { src: string | null | undefined; name: string; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const style = { "--size": `${size}px` } as React.CSSProperties;
  if (!src || failed) {
    return (
      <span className={s.tile} style={style} aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    <span className={s.frame} style={style} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </span>
  );
}
