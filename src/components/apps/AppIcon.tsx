"use client";
import * as React from "react";
import s from "./appIcon.module.css";

/** An app's icon from its CasaOS/selfh.st URL, falling back to a lettered tile if it fails to load. */
/** Remote icons go through Gluon's icon cache; data: and same-origin URLs are used as they are. */
export function iconSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  return /^https?:\/\//i.test(src) ? `/api/icon?u=${encodeURIComponent(src)}` : src;
}

export function AppIcon({ src, name, size = 32 }: { src: string | null | undefined; name: string; size?: number }) {
  const [failed, setFailed] = React.useState<string | null>(null);
  const img = React.useRef<HTMLImageElement>(null);
  // An image that failed before hydration never reaches React's onError: check once mounted.
  React.useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0 && src) setFailed(src);
  }, [src]);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const style = { "--size": `${size}px` } as React.CSSProperties;
  if (!src || failed === src) {
    return (
      <span className={s.tile} style={style} aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    <span className={s.frame} style={style} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={img} src={iconSrc(src) ?? undefined} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />
    </span>
  );
}
