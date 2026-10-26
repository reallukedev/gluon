"use client";
import * as React from "react";
import { useFormat } from "@/components/PrefsProvider";
import type { UsageChildren, UsageEntry, UsageResult } from "@/lib/storage-types";
import s from "./storage.module.css";

/** Something Gluon can clean up, hung on the block of the folder it lives in. */
export interface SpaceHint {
  path: string;
  bytes: number;
  title: string;
  /** Opens the confirmation for this cleanup. */
  run: () => void;
  action: string;
}

export interface Block {
  key: string;
  kind: "dir" | "file" | "other" | "free";
  name: string;
  path: string | null;
  bytes: number;
  share: number;
  depth: 1 | 2;
  x: number;
  y: number;
  w: number;
  h: number;
  parent?: string;
}

// ---------------------------------------------------------------- squarified treemap

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, v) => a + v, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/** Bruls, Huizing and van Wijk's squarified layout: rectangles as close to square as the sizes allow. */
function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, v) => a + v, 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => Math.max(v * scale, 0.0001));
  const out: Rect[] = [];
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    let row = [areas[i]!];
    let j = i + 1;
    while (j < areas.length) {
      const next = [...row, areas[j]!];
      if (worst(next, side) > worst(row, side)) break;
      row = next;
      j++;
    }
    const sum = row.reduce((a, v) => a + v, 0);
    if (w >= h) {
      const cw = sum / h;
      let yy = y;
      for (const a of row) {
        const hh = a / cw;
        out.push({ x, y: yy, w: cw, h: hh });
        yy += hh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const a of row) {
        const ww = a / rh;
        out.push({ x: xx, y, w: ww, h: rh });
        xx += ww;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

interface Item {
  key: string;
  kind: Block["kind"];
  name: string;
  path: string | null;
  bytes: number;
}

function itemsOf(entries: UsageEntry[], otherBytes: number, otherCount: number, free: number | null, keyPrefix: string): Item[] {
  const items: Item[] = entries.filter((e) => !e.mountpoint && e.bytes > 0).map((e) => ({ key: e.path, kind: e.dir ? "dir" : "file", name: e.name, path: e.path, bytes: e.bytes }));
  if (otherBytes > 0 && otherCount > 0) items.push({ key: `${keyPrefix}:other`, kind: "other", name: `${otherCount.toLocaleString()} smaller`, path: null, bytes: otherBytes });
  if (free && free > 0) items.push({ key: `${keyPrefix}:free`, kind: "free", name: "Free", path: null, bytes: free });
  return items.sort((a, b) => b.bytes - a.bytes);
}

const HEAD = 24;

/** Lay out one level, and inside every block big enough, the level below it. */
export function layoutMap(result: UsageResult, W: number, H: number, withFree: boolean): Block[] {
  const free = withFree && result.filesystem ? result.filesystem.avail : null;
  const items = itemsOf(result.entries, result.otherBytes, result.otherCount, free, result.path);
  const total = items.reduce((a, it) => a + it.bytes, 0) || 1;
  // Lay out on a canvas one pixel bigger, then shrink every block by that pixel: the gaps are the rules.
  const rects = squarify(
    items.map((it) => it.bytes),
    { x: 0, y: 0, w: W + 1, h: H + 1 },
  );
  const blocks: Block[] = [];
  items.forEach((it, i) => {
    const r = rects[i]!;
    const b: Block = { ...it, share: it.bytes / total, depth: 1, x: r.x, y: r.y, w: r.w - 1, h: r.h - 1 };
    blocks.push(b);
    const kids: UsageChildren | undefined = it.path ? result.children?.[it.path] : undefined;
    if (!kids || it.kind !== "dir" || b.w < 120 || b.h < 76) return;
    const inner = itemsOf(kids.entries, kids.otherBytes, kids.otherCount, null, it.key);
    if (inner.length < 2) return;
    const innerTotal = inner.reduce((a, x) => a + x.bytes, 0) || 1;
    const box = { x: b.x + 4, y: b.y + HEAD, w: b.w - 8 + 1, h: b.h - HEAD - 4 + 1 };
    const sub = squarify(
      inner.map((x) => x.bytes),
      box,
    );
    inner.forEach((c, k) => {
      const q = sub[k]!;
      if (q.w < 3 || q.h < 3) return;
      blocks.push({ ...c, share: c.bytes / innerTotal, depth: 2, x: q.x, y: q.y, w: q.w - 1, h: q.h - 1, parent: it.key });
    });
  });
  return blocks;
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Cleanups inside a folder, one per kind (an old copy split over two folders counts once). */
export function hintsFor(path: string | null, hints: SpaceHint[]): SpaceHint[] {
  if (!path) return [];
  const byTitle = new Map<string, SpaceHint>();
  for (const h of hints) {
    if (h.path !== path && !h.path.startsWith(`${path === "/" ? "" : path}/`)) continue;
    const had = byTitle.get(h.title);
    byTitle.set(h.title, had ? { ...had, bytes: had.bytes + h.bytes } : h);
  }
  return [...byTitle.values()];
}

/**
 * What's using space, as a map: every block is a folder or file drawn at its share of the space, in
 * 1px rules; the biggest folders show what's inside them. Hover or focus a block to read it below
 * the map; click (or Enter) to look inside. Blocks holding something Gluon can clean up carry a mark.
 */
export function SpaceMap({
  result,
  withFree,
  hints,
  urgent,
  active,
  onActive,
  onDrill,
}: {
  result: UsageResult;
  withFree: boolean;
  hints: SpaceHint[];
  /** The drive is nearly full: cleanups need the person (sodium), not just "could". */
  urgent: boolean;
  active: string | null;
  onActive: (block: Block | null) => void;
  onDrill: (path: string) => void;
}) {
  const fmt = useFormat();
  const [ref, W] = useSize<HTMLDivElement>();
  const H = Math.round(Math.max(240, Math.min(440, W * 0.44)));
  const blocks = React.useMemo(() => (W > 0 ? layoutMap(result, W, H, withFree) : []), [result, W, H, withFree]);
  const nested = new Set(blocks.filter((b) => b.depth === 2).map((b) => b.parent));
  const pct = (x: number) => (x < 0.001 ? "<0.1%" : x < 0.1 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const label = (b: Block) => {
    const hs = hintsFor(b.path, hints);
    return `${b.kind === "free" ? "Free space" : b.kind === "other" ? `${b.name} items` : b.name}, ${fmt.bytes(b.bytes)}, ${pct(b.share)}${b.depth === 2 ? " of its folder" : ""}${hs.length ? `. ${fmt.bytes(hs.reduce((a, h) => a + h.bytes, 0))} can be cleaned up` : ""}${b.kind === "dir" ? ". Press Enter to look inside" : ""}`;
  };

  return (
    <div ref={ref} className={s.mapWrap}>
      <div className={s.map} style={{ height: H }} role="group" aria-label={`Space used in ${result.path}, as a map`} key={result.path} onMouseLeave={() => {
          if (hoverTimer.current) clearTimeout(hoverTimer.current);
          onActive(null);
        }}>
        {blocks.map((b) => {
          const hs = hintsFor(b.path, hints);
          const big = b.w >= 64 && b.h >= (b.depth === 1 ? 38 : 30);
          const style: React.CSSProperties & Record<string, string | number> = { left: b.x, top: b.y, width: Math.max(0, b.w), height: Math.max(0, b.h), "--shade": `${Math.round((b.depth === 1 ? 3 : 2) + Math.sqrt(b.share) * (b.depth === 1 ? 10 : 8))}%` };
          const drillable = b.kind === "dir" && !!b.path;
          const common = {
            className: s.block,
            style,
            "data-kind": b.kind,
            "data-depth": b.depth,
            "data-nested": nested.has(b.key) ? "" : undefined,
            "data-active": active === b.key ? "" : undefined,
            "data-hint": hs.length ? (urgent ? "urgent" : "") : undefined,
            onMouseEnter: () => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
              hoverTimer.current = setTimeout(() => onActive(b), 40);
            },
            onFocus: () => onActive(b),
          };
          const content = big && (
            <span className={s.blockHead}>
              <span className={s.blockName}>{b.kind === "free" ? "Free" : b.name}</span>
              <span className={`${s.blockSize} num`}>
                {fmt.bytes(b.bytes)}
                {b.w >= 120 && <span className={s.blockPct}> · {pct(b.share)}</span>}
              </span>
            </span>
          );
          const mark = hs.length > 0 && b.w >= 18 && b.h >= 18 && <span className={s.blockMark} aria-hidden />;
          return drillable ? (
            <button key={b.key} type="button" {...common} tabIndex={b.depth === 1 ? 0 : -1} aria-label={label(b)} onClick={() => onDrill(b.path!)}>
              {content}
              {mark}
            </button>
          ) : (
            <div key={b.key} {...common} role="img" aria-label={label(b)} tabIndex={b.depth === 1 ? 0 : -1}>
              {content}
              {mark}
            </div>
          );
        })}
      </div>
    </div>
  );
}
