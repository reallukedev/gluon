"use client";
import * as React from "react";
import { Download, InfoCircle, NavArrowLeft, NavArrowRight, OpenNewWindow, Xmark, Folder } from "iconoir-react";
import type { FileEntry, SearchHit } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { statEntry } from "./hooks";
import { useFiles } from "./Files";
import { Facts, PreviewBody } from "./PreviewBody";
import { Thumb } from "./Thumb";
import { baseName, downloadUrl, parentOf, rawUrl, useMediaQuery } from "./lib";
import s from "./lightbox.module.css";

const isEntry = (x: FileEntry | SearchHit): x is FileEntry => "mode" in x;

/**
 * Quick look for photos and video: the picture as large as the window allows, a strip of the
 * others beside it, details on I, arrows or a swipe to step, Esc to leave. Opens and closes
 * without animation because it's used dozens of times in a row.
 */
export function Lightbox({ entry, siblings, onChange, onClose }: { entry: FileEntry; siblings: (FileEntry | SearchHit)[]; onChange: (e: FileEntry) => void; onClose: () => void }) {
  const f = useFiles();
  const fmt = useFormat();
  const [info, setInfo] = React.useState(false);
  const narrow = useMediaQuery("(max-width: 720px)");
  const media = React.useMemo(() => {
    const list = siblings.filter((x) => x.kind === "image" || x.kind === "video");
    return list.some((x) => x.path === entry.path) ? list : [entry, ...list];
  }, [siblings, entry]);
  const idx = media.findIndex((x) => x.path === entry.path);
  const step = React.useCallback(
    async (d: number) => {
      const next = media[idx + d];
      if (!next) return;
      if (isEntry(next)) return onChange(next);
      try {
        onChange(await statEntry(next.path));
      } catch {
        /* it went away; stay */
      }
    },
    [idx, media, onChange],
  );
  const film = React.useRef<HTMLDivElement>(null);
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    film.current?.querySelector<HTMLElement>("[data-on]")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [entry.path]);
  // Keys, focus and the page's scroll are taken once, on open; the handlers read the latest step and close.
  const keys = React.useRef({ step, onClose });
  keys.current = { step, onClose };
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const box = root.current;
      if (e.key === "Tab" && box) {
        // A modal keeps Tab inside it: from the last control back to the first, and the other way.
        const focusable = [...box.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input,video,audio,[tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        const at = document.activeElement;
        if (e.shiftKey && (at === first || at === box || !box.contains(at))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (at === last || !box.contains(at))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.target instanceof Element && e.target.closest("input,textarea,video,audio,[role=menu]")) return;
      // Space closes like it opened, unless it's pressing a focused button.
      if (e.key === "Escape" || (e.key === " " && !(e.target instanceof Element && e.target.closest("button")))) keys.current.onClose();
      else if (e.key === "ArrowRight") void keys.current.step(1);
      else if (e.key === "ArrowLeft") void keys.current.step(-1);
      else if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey) setInfo((v) => !v);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);
  const swipe = React.useRef<{ x: number; y: number } | null>(null);
  const showIn = () => {
    onClose();
    f.go(parentOf(entry.path), { select: baseName(entry.path) });
  };
  return (
    <div ref={root} className={s.box} role="dialog" aria-modal aria-label={entry.name} data-info={info ? "" : undefined} tabIndex={-1}>
      <div className={s.bar}>
        <IconButton label="Close" shortcut="Esc" onClick={onClose}>
          <Xmark />
        </IconButton>
        <span className={s.title}>
          <span className="truncate">{entry.name}</span>
          {media.length > 1 && idx >= 0 && (
            <span className="num muted">
              {idx + 1} of {media.length}
            </span>
          )}
        </span>
        {/* Phones get the same actions as icons, so the name keeps its room. */}
        {f.path !== parentOf(entry.path) &&
          (narrow ? (
            <IconButton label="Show in folder" size="sm" onClick={showIn}>
              <Folder />
            </IconButton>
          ) : (
            <Button size="sm" variant="ghost" icon={<Folder />} onClick={showIn}>
              Show in folder
            </Button>
          ))}
        {!narrow && (
          <IconButton label="Open in a new tab" size="sm" onClick={() => window.open(rawUrl(entry.path), "_blank", "noopener")}>
            <OpenNewWindow />
          </IconButton>
        )}
        {narrow ? (
          <IconButton label="Download" size="sm" onClick={() => downloadUrl(rawUrl(entry.path, true))}>
            <Download />
          </IconButton>
        ) : (
          <Button size="sm" variant="ghost" icon={<Download />} onClick={() => downloadUrl(rawUrl(entry.path, true))}>
            Download
          </Button>
        )}
        <IconButton label={info ? "Hide details" : "Show details"} shortcut="I" onClick={() => setInfo((v) => !v)} aria-pressed={info}>
          <InfoCircle />
        </IconButton>
      </div>
      <div
        className={s.stage}
        onTouchStart={(e) => {
          const t = e.touches[0];
          swipe.current = !t || e.touches.length > 1 ? null : { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const st = swipe.current;
          const t = e.changedTouches[0];
          swipe.current = null;
          if (!st || !t) return;
          const dx = t.clientX - st.x;
          if (Math.abs(dx) > 60 && Math.abs(t.clientY - st.y) < 50) void step(dx < 0 ? 1 : -1);
        }}
      >
        <IconButton label="Previous" shortcut="←" className={s.prev} disabled={idx <= 0} onClick={() => void step(-1)}>
          <NavArrowLeft />
        </IconButton>
        <div className={s.body} data-kind={entry.preview ?? "none"}>
          <PreviewBody entry={entry} />
        </div>
        <IconButton label="Next" shortcut="→" className={s.next} disabled={idx < 0 || idx >= media.length - 1} onClick={() => void step(1)}>
          <NavArrowRight />
        </IconButton>
        {info && (
          <aside className={s.info} aria-label="Details">
            <Facts entry={entry} admin={f.admin} />
          </aside>
        )}
      </div>
      {media.length > 1 && (
        <div className={s.film} ref={film} role="list" aria-label="Photos and videos here">
          {media.map((x) => (
            <button
              key={x.path}
              type="button"
              role="listitem"
              className={s.filmItem}
              data-on={x.path === entry.path ? "" : undefined}
              aria-label={x.name}
              aria-current={x.path === entry.path ? "true" : undefined}
              tabIndex={-1}
              onClick={() => (isEntry(x) ? onChange(x) : void statEntry(x.path).then(onChange, () => undefined))}
            >
              <Thumb item={x} size={160} />
            </button>
          ))}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {entry.name}, {fmt.bytes(entry.size)}
      </span>
    </div>
  );
}
