"use client";
import * as React from "react";
import s from "./appIcon.module.css";

/** An app's icon from its CasaOS/selfh.st URL, falling back to a lettered tile if it fails to load. */
/** Remote icons go through Gluon's icon cache; data: and same-origin URLs are used as they are. */
export function iconSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  return /^https?:\/\//i.test(src) ? `/api/icon?u=${encodeURIComponent(src)}` : src;
}

/**
 * The app's initials, set like a stamped nameplate: "Tend Dev" → "TD", "Umbrel" → "Um", "n8n" → "N8".
 * Words split on spaces, dashes, dots and camelCase; version-ish words and "the" are skipped.
 */
export function monogram(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .filter((w) => w && !/^(the|v?\d+(\.\d+)*)$/i.test(w));
  if (!words.length) return (name.trim()[0] ?? "?").toUpperCase();
  if (words.length === 1) {
    const w = words[0]!;
    return w.length > 1 ? w[0]!.toUpperCase() + w[1]!.toLowerCase() : w.toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function AppIcon({ src, name, size = 32 }: { src: string | null | undefined; name: string; size?: number }) {
  const [failed, setFailed] = React.useState<string | null>(null);
  const img = React.useRef<HTMLImageElement>(null);
  // An image that failed before hydration never reaches React's onError: check once mounted.
  React.useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0 && src) setFailed(src);
  }, [src]);
  const letters = monogram(name);
  const style = { "--size": `${size}px` } as React.CSSProperties;
  if (!src || failed === src) {
    return (
      <span className={s.tile} style={style} data-n={letters.length} data-small={size < 26 ? "" : undefined} aria-hidden>
        {letters}
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
