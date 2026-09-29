"use client";
import * as React from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { MediaVideo, MoreHoriz, SortDown, SortUp } from "iconoir-react";
import type { FileEntry, SortKey } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Checkbox } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/Button";
import { ContextMenu, Menu, type MenuEntry } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { DRAG_MIME, FolderGlyph, KindIcon, POSTERABLE, THUMBABLE, isDirLike, rawUrl, thumbUrl, useDropTarget, useVideoPoster } from "./lib";
import s from "./files.module.css";

export type ClipOp = "copy" | "cut" | "paste" | "duplicate";

export interface ListingHandlers {
  onOpen: (e: FileEntry) => void;
  onPreview: (e: FileEntry) => void;
  onUp: () => void;
  onTrash: (entries: FileEntry[]) => void;
  onRename: (e: FileEntry) => void;
  onRenameCommit: (e: FileEntry, name: string) => void;
  onRenameCancel: () => void;
  onCalculate: (e: FileEntry) => void;
  onDropItems: (sources: string[], dest: string, copy: boolean) => void;
  menuFor: (entries: FileEntry[]) => MenuEntry[];
  backgroundMenu: MenuEntry[];
  onSelectAll: () => void;
  /** ⌘C, ⌘X, ⌘V and ⌘D inside the listing. */
  onClipboard: (op: ClipOp) => void;
}

interface Props extends ListingHandlers {
  rows: (FileEntry | undefined)[];
  total: number;
  ensure: (i: number) => void;
  view: "list" | "grid";
  sort: SortKey;
  order: "asc" | "desc";
  onSort: (k: SortKey) => void;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  writable: boolean;
  renaming: string | null;
  /** What the rename field starts with, when a rename failed and is being retried. */
  renameDraft?: string | null;
  /** Scroll to and focus this path once it's loaded (after create/rename/upload, or coming back up). */
  reveal: string | null;
  /** Folder that files dragged in from the computer would be uploaded into (highlighted). */
  dropPath?: string | null;
  /** The Owner column (the Linux user): admins only; it means nothing to a household member. */
  showOwner?: boolean;
  /** Folder sizes are being measured right now: unmeasured folders show that instead of a dash. */
  measuring?: boolean;
  /** Items cut to the Files clipboard (drawn faded until pasted). */
  cutPaths?: Set<string> | null;
  /** A touch screen: long-press selects, there is no right-click menu. */
  touch?: boolean;
}

const GRID_MIN = 156;
const GRID_GAP = 12;
const LONG_PRESS_MS = 450;

function cssPx(name: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The folder contents: a virtualised list or grid over the window scroll, with multi-select
 * (click, ⇧-click ranges, ⌘/Ctrl-click, checkboxes, long-press on touch), keyboard navigation,
 * a context menu, and dragging items onto folders to move them.
 */
export function Listing(props: Props) {
  const { rows, total, ensure, view, selected, setSelected, writable, renaming, reveal, dropPath } = props;
  const typed = React.useRef({ text: "", at: 0 });
  const wrap = React.useRef<HTMLDivElement>(null);
  const inner = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(900);
  const [margin, setMargin] = React.useState(0);
  const [focus, setFocus] = React.useState(0);
  const anchor = React.useRef(0);
  const [rowH, setRowH] = React.useState(44);
  const [ctxItems, setCtxItems] = React.useState<MenuEntry[]>(props.backgroundMenu);

  React.useLayoutEffect(() => {
    setRowH(cssPx("--row", 44) + 2);
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setMargin((inner.current ?? el).getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [view]);

  // Things above the list (notices, the selection bar) move it; keep the scroll offset in step.
  React.useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const m = Math.round(el.getBoundingClientRect().top + window.scrollY);
    if (Math.abs(m - margin) > 1) setMargin(m);
  });

  const cols = view === "grid" ? Math.max(2, Math.floor((width + GRID_GAP) / (GRID_MIN + GRID_GAP))) : 1;
  const tileW = view === "grid" ? (width - GRID_GAP * (cols - 1)) / cols : 0;
  const lineH = view === "grid" ? Math.round(tileW * 0.72 + 58 + GRID_GAP) : rowH;
  const count = view === "grid" ? Math.ceil(total / cols) : total;

  const v = useWindowVirtualizer({ count, estimateSize: () => lineH, overscan: 8, scrollMargin: margin });
  React.useEffect(() => v.measure(), [lineH, v]);
  const items = v.getVirtualItems();

  React.useEffect(() => {
    for (const it of items) ensure(it.index * cols);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.index).join(","), cols, ensure]);

  React.useEffect(() => {
    if (!reveal) return;
    const i = rows.findIndex((r) => r?.path === reveal);
    if (i >= 0) {
      setFocus(i);
      anchor.current = i;
      v.scrollToIndex(Math.floor(i / cols), { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, rows]);

  // When a rename ends (saved or cancelled) the field goes away: give the keyboard back to the list.
  const wasRenaming = React.useRef(renaming);
  React.useEffect(() => {
    if (wasRenaming.current && !renaming && (!document.activeElement || document.activeElement === document.body)) wrap.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);

  const entriesOf = (set: Set<string>) => rows.filter((r): r is FileEntry => !!r && set.has(r.path));

  const selectIndex = (i: number, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const e = rows[i];
    if (!e) return;
    if (ev.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      const next = new Set(ev.metaKey || ev.ctrlKey ? selected : []);
      for (let k = a; k <= b; k++) {
        const r = rows[k];
        if (r) next.add(r.path);
      }
      setSelected(next);
    } else if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(e.path)) next.delete(e.path);
      else next.add(e.path);
      setSelected(next);
      anchor.current = i;
    } else {
      setSelected(new Set([e.path]));
      anchor.current = i;
    }
    setFocus(i);
  };

  const toggle = (i: number) => {
    const e = rows[i];
    if (!e) return;
    const next = new Set(selected);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    setSelected(next);
    anchor.current = i;
    setFocus(i);
  };

  const moveFocus = (to: number, extend: boolean) => {
    if (!total) return;
    const i = Math.max(0, Math.min(total - 1, to));
    if (extend) selectIndex(i, { shiftKey: true, metaKey: false, ctrlKey: false });
    else {
      setFocus(i);
      anchor.current = i;
      const e = rows[i];
      if (e) setSelected(new Set([e.path]));
    }
    ensure(i);
    v.scrollToIndex(Math.floor(i / cols), { align: "auto" });
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (renaming || (ev.target as HTMLElement).closest("input,button,[role=menuitem],[role=checkbox]")) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const cur = rows[focus];
    const step = view === "grid" ? cols : 1;
    switch (ev.key) {
      case "ArrowDown":
        if (mod && cur) props.onOpen(cur);
        else moveFocus(focus + step, ev.shiftKey);
        break;
      case "ArrowUp":
        if (mod || ev.altKey) props.onUp();
        else moveFocus(focus - step, ev.shiftKey);
        break;
      case "ArrowRight":
        if (view !== "grid") return;
        moveFocus(focus + 1, ev.shiftKey);
        break;
      case "ArrowLeft":
        if (view !== "grid") return;
        moveFocus(focus - 1, ev.shiftKey);
        break;
      case "Home":
        moveFocus(0, ev.shiftKey);
        break;
      case "End":
        moveFocus(total - 1, ev.shiftKey);
        break;
      case "PageDown":
      case "PageUp": {
        const page = Math.max(1, Math.floor(window.innerHeight / lineH) - 1) * step;
        moveFocus(focus + (ev.key === "PageDown" ? page : -page), ev.shiftKey);
        break;
      }
      case "Enter":
        if (cur) props.onOpen(cur);
        break;
      case " ":
        if (cur && !isDirLike(cur)) props.onPreview(cur);
        else if (cur) toggle(focus);
        break;
      case "Backspace":
        if (mod && writable && selected.size) props.onTrash(entriesOf(selected));
        else props.onUp();
        break;
      case "Delete":
        if (writable && selected.size) props.onTrash(entriesOf(selected));
        break;
      case "F2":
        if (writable && cur) props.onRename(cur);
        break;
      case "Escape":
        if (!selected.size) return;
        setSelected(new Set());
        break;
      default: {
        if (mod && !ev.altKey && !ev.shiftKey) {
          const k = ev.key.toLowerCase();
          if (k === "a") props.onSelectAll();
          else if (k === "c" && selected.size) props.onClipboard("copy");
          else if (k === "x" && selected.size && writable) props.onClipboard("cut");
          else if (k === "v" && writable) props.onClipboard("paste");
          else if (k === "d" && selected.size && writable) props.onClipboard("duplicate");
          else return;
          break;
        }
        // Type the start of a name to jump to it, like a desktop file manager.
        if (mod || ev.altKey || ev.key.length !== 1 || ev.key === " ") return;
        const now = Date.now();
        const t = typed.current;
        t.text = now - t.at > 800 ? ev.key.toLowerCase() : t.text + ev.key.toLowerCase();
        t.at = now;
        const from = t.text.length === 1 ? focus + 1 : focus;
        let hit = -1;
        for (let k = 0; k < rows.length && hit < 0; k++) {
          const i = (from + k) % rows.length;
          if (rows[i]?.name.toLowerCase().startsWith(t.text)) hit = i;
        }
        if (hit < 0) return;
        moveFocus(hit, false);
      }
    }
    ev.preventDefault();
  };

  const onContextMenu = (ev: React.MouseEvent) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!el) {
      setCtxItems(props.backgroundMenu);
      return;
    }
    const i = Number(el.dataset.index);
    const e = rows[i];
    if (!e) return;
    let sel = selected;
    if (!selected.has(e.path)) {
      sel = new Set([e.path]);
      setSelected(sel);
      anchor.current = i;
    }
    setFocus(i);
    setCtxItems(props.menuFor(entriesOf(sel).length ? entriesOf(sel) : [e]));
  };

  const handlers: ListingHandlers = {
    onOpen: props.onOpen,
    onPreview: props.onPreview,
    onUp: props.onUp,
    onTrash: props.onTrash,
    onRename: props.onRename,
    onRenameCommit: props.onRenameCommit,
    onRenameCancel: props.onRenameCancel,
    onCalculate: props.onCalculate,
    onDropItems: props.onDropItems,
    menuFor: props.menuFor,
    backgroundMenu: props.backgroundMenu,
    onSelectAll: props.onSelectAll,
    onClipboard: props.onClipboard,
  };
  const loadedCount = rows.filter(Boolean).length;
  const allSelected = loadedCount > 0 && selected.size >= loadedCount;
  const active = rows[focus];
  const itemCommon = {
    renameDraft: props.renameDraft ?? null,
    writable,
    selectedPaths: selected,
    measuring: !!props.measuring,
    touch: !!props.touch,
    onSelect: selectIndex,
    onToggle: toggle,
    ...handlers,
  };

  const body = (
    <div
      ref={wrap}
      className={s.listing}
      data-owner={props.showOwner ? "" : undefined}
      data-view={view}
      role="grid"
      aria-multiselectable
      aria-rowcount={total}
      aria-label="Folder contents"
      tabIndex={0}
      aria-activedescendant={active ? `row-${focus}` : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (e.target === e.currentTarget && selected.size) setSelected(new Set());
      }}
    >
      {view === "list" && (
        <div className={s.headRow} role="row">
          <span role="columnheader" className={s.checkCell}>
            <Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} onChange={(c) => (c ? props.onSelectAll() : setSelected(new Set()))}>
              <span className="sr-only">Select everything in this folder</span>
            </Checkbox>
          </span>
          <SortHeader label="Name" k="name" {...props} />
          <SortHeader label="Size" k="size" {...props} className={s.sizeCol} />
          <SortHeader label="Modified" k="mtime" {...props} className={s.dateCol} />
          <span role="columnheader" className={s.ownerCol}>
            Owner
          </span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
      )}
      <div ref={inner} style={{ height: v.getTotalSize(), position: "relative" }}>
        {items.map((it) => {
          const top = it.start - v.options.scrollMargin;
          if (view === "list") {
            const e = rows[it.index];
            return (
              <div key={it.key} className={s.vrow} style={{ transform: `translateY(${top}px)`, height: rowH }}>
                {e ? (
                  <Row
                    entry={e}
                    index={it.index}
                    selected={selected.has(e.path)}
                    focused={focus === it.index}
                    renaming={renaming === e.path}
                    osDrop={dropPath === e.path}
                    cut={!!props.cutPaths?.has(e.path)}
                    {...itemCommon}
                  />
                ) : (
                  <SkeletonRow i={it.index} />
                )}
              </div>
            );
          }
          const start = it.index * cols;
          return (
            <div key={it.key} className={s.vgrid} role="row" style={{ transform: `translateY(${top}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GRID_GAP }}>
              {Array.from({ length: cols }, (_, c) => {
                const i = start + c;
                if (i >= total) return <span key={c} />;
                const e = rows[i];
                return e ? (
                  <Tile
                    key={e.path}
                    entry={e}
                    index={i}
                    selected={selected.has(e.path)}
                    focused={focus === i}
                    renaming={renaming === e.path}
                    osDrop={dropPath === e.path}
                    cut={!!props.cutPaths?.has(e.path)}
                    height={lineH - GRID_GAP}
                    {...itemCommon}
                  />
                ) : (
                  <Skeleton key={c} height={lineH - GRID_GAP} radius={12} />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <ContextMenu items={ctxItems} disabled={props.touch}>
      {body}
    </ContextMenu>
  );
}

function SkeletonRow({ i }: { i: number }) {
  return (
    <div className={s.row} aria-hidden data-skeleton="">
      <span />
      <span className={s.nameCell}>
        <Skeleton width={18} height={18} radius={4} />
        <Skeleton width={`${26 + ((i * 37) % 44)}%`} />
      </span>
      <span className={s.sizeCol}>
        <Skeleton width={44} />
      </span>
      <span className={s.dateCol}>
        <Skeleton width={78} />
      </span>
      <span className={s.ownerCol}>
        <Skeleton width={36} />
      </span>
      <span />
    </div>
  );
}

/** A folder that hasn't loaded yet, shaped like the list or grid that will replace it. */
export function ListingSkeleton({ view, showOwner }: { view: "list" | "grid"; showOwner?: boolean }) {
  if (view === "grid") {
    return (
      <div className={s.gridSkeleton} aria-busy aria-label="Loading this folder">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className={s.tile} data-skeleton="">
            <div className={s.thumb} />
            <div className={s.tileText}>
              <Skeleton width={`${50 + ((i * 29) % 40)}%`} height={12} />
              <Skeleton width="45%" height={10} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={s.listing} data-owner={showOwner ? "" : undefined} aria-busy aria-label="Loading this folder">
      <div className={s.headRow} aria-hidden>
        <span />
        <span>Name</span>
        <span className={s.sizeCol}>Size</span>
        <span className={s.dateCol}>Modified</span>
        <span className={s.ownerCol}>Owner</span>
        <span />
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={s.skeletonLine}>
          <SkeletonRow i={i} />
        </div>
      ))}
    </div>
  );
}

function SortHeader({ label, k, sort, order, onSort, className }: { label: string; k: SortKey; sort: SortKey; order: "asc" | "desc"; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === k;
  return (
    <span role="columnheader" className={className} aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={s.sortBtn} data-active={active ? "" : undefined} onClick={() => onSort(k)}>
        {label}
        {active && (order === "asc" ? <SortUp /> : <SortDown />)}
      </button>
    </span>
  );
}

interface ItemProps extends ListingHandlers {
  entry: FileEntry;
  /** Files from the computer would be uploaded into this folder. */
  osDrop?: boolean;
  index: number;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  writable: boolean;
  selectedPaths: Set<string>;
  renameDraft: string | null;
  measuring: boolean;
  cut: boolean;
  touch: boolean;
  onSelect: (i: number, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  onToggle: (i: number) => void;
}

function useItem(p: ItemProps) {
  const dir = isDirLike(p.entry);
  const drop = useDropTarget(dir && !p.entry.link?.outside ? p.entry.path : null, p.onDropItems, p.writable);
  // Long-press on a touch screen selects (the way phone file apps do); the tap that ends it is eaten.
  const press = React.useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    if (press.current && !press.current.fired) press.current = null;
  };
  const common = {
    id: `row-${p.index}`,
    "data-index": p.index,
    "aria-selected": p.selected,
    "data-focused": p.focused ? "" : undefined,
    "data-drop": drop.over || p.osDrop ? "" : undefined,
    "data-cut": p.cut ? "" : undefined,
    draggable: p.writable && !p.renaming && !p.touch,
    onDragStart: (ev: React.DragEvent) => {
      const paths = p.selectedPaths.has(p.entry.path) ? [...p.selectedPaths] : [p.entry.path];
      ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      ev.dataTransfer.effectAllowed = "copyMove";
    },
    onPointerDown: (ev: React.PointerEvent) => {
      if (ev.pointerType !== "touch" || (ev.target as HTMLElement).closest("button,input,a,[role=checkbox]")) return;
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        if (!p.selected) p.onToggle(p.index);
        navigator.vibrate?.(8);
      }, LONG_PRESS_MS);
      press.current = { timer, x: ev.clientX, y: ev.clientY, fired: false };
    },
    onPointerMove: (ev: React.PointerEvent) => {
      const c = press.current;
      if (c && !c.fired && Math.hypot(ev.clientX - c.x, ev.clientY - c.y) > 8) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClick: (ev: React.MouseEvent) => {
      if (press.current?.fired) {
        press.current = null;
        return;
      }
      if ((ev.target as HTMLElement).closest("button,input,a,[role=checkbox]")) return;
      // On touch screens a tap opens (like a phone's file app) unless you're selecting.
      const touch = p.touch || (ev.nativeEvent as PointerEvent).pointerType === "touch";
      if (touch && !p.selectedPaths.size) return p.onOpen(p.entry);
      if (touch) return p.onToggle(p.index);
      p.onSelect(p.index, ev);
    },
    onDoubleClick: (ev: React.MouseEvent) => {
      if (p.touch || (ev.target as HTMLElement).closest("button,input,[role=checkbox]")) return;
      p.onOpen(p.entry);
    },
    ...drop.props,
  };
  return { dir, common };
}

function RowMenu(p: ItemProps) {
  return (
    <Menu
      trigger={
        <IconButton label={`${p.entry.name} actions`} size="sm" tooltip={false}>
          <MoreHoriz />
        </IconButton>
      }
      items={p.menuFor([p.entry])}
    />
  );
}

/** A link's note after its name: where it points, or that it's broken (a short red mark and words). */
function LinkNote({ entry: e }: { entry: FileEntry }) {
  if (!e.link) return null;
  if (e.link.broken) {
    return (
      <span className={s.linkNote} data-broken="" title={`Points to ${e.link.target}, which doesn't exist`}>
        <i className={s.brokenMark} aria-hidden />
        broken link
      </span>
    );
  }
  return (
    <span className={s.linkNote} data-path="" title={`Link to ${e.link.resolved ?? e.link.target}`}>
      → {e.link.target}
    </span>
  );
}

/** Size of a row: bytes for files, the measured total for folders, a measuring line, or a dash. */
function SizeValue({ p, dir, compact }: { p: ItemProps; dir: boolean; compact?: boolean }) {
  const fmt = useFormat();
  const e = p.entry;
  if (!dir) return e.link?.broken ? <span className={s.faintDash}>—</span> : <>{fmt.bytes(e.size)}</>;
  if (e.dirSize) return <span title={`Measured ${fmt.relative(e.dirSize.computedAt)}`}>{fmt.bytes(e.dirSize.bytes)}</span>;
  if (compact) return <>{e.link ? "Link to a folder" : "Folder"}</>;
  if (p.measuring && !e.link) return <span className={s.measuring} role="img" aria-label="Measuring" />;
  return (
    <button type="button" className={s.calc} onClick={() => p.onCalculate(e)} aria-label={`Calculate the size of ${e.name}`}>
      <span className={s.calcDash}>—</span>
      <span className={s.calcLabel}>Calculate</span>
    </button>
  );
}

const Row = React.memo(function Row(p: ItemProps) {
  const { dir, common } = useItem(p);
  const e = p.entry;
  return (
    <div className={s.row} role="row" {...common}>
      <span role="gridcell" className={s.checkCell}>
        <Checkbox checked={p.selected} onChange={() => p.onToggle(p.index)}>
          <span className="sr-only">Select {e.name}</span>
        </Checkbox>
      </span>
      <span role="gridcell" className={s.nameCell} data-hidden={e.hidden ? "" : undefined}>
        <KindIcon kind={e.kind} type={e.type} className={s.kindIcon} />
        {p.renaming ? (
          <RenameInput entry={e} initial={p.renameDraft} onCommit={p.onRenameCommit} onCancel={p.onRenameCancel} />
        ) : (
          <span className={s.nameText}>
            <span className={s.nameLabel} title={e.name}>
              {e.name}
            </span>
            <LinkNote entry={e} />
          </span>
        )}
        <span className={`${s.mobileMeta} num`}>
          {e.link?.broken ? (
            "Broken link"
          ) : (
            <>
              <SizeValue p={p} dir={dir} compact /> · <Time ts={e.mtime} />
            </>
          )}
        </span>
      </span>
      <span role="gridcell" className={`${s.sizeCol} num`}>
        <SizeValue p={p} dir={dir} />
      </span>
      <span role="gridcell" className={`${s.dateCol} num`}>
        <Time ts={e.mtime} />
      </span>
      <span role="gridcell" className={s.ownerCol} title={`Owner ${e.owner ?? e.uid}, group ${e.group ?? e.gid}, ${e.mode}`}>
        {e.owner ?? e.uid}
      </span>
      <span role="gridcell" className={s.rowActions}>
        <RowMenu {...p} />
      </span>
    </div>
  );
});

function extOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return null;
  const x = name.slice(i + 1);
  return x.length <= 5 ? x.toUpperCase() : null;
}

/** What fills a tile: a real thumbnail, a video's poster frame, the folder glyph, or the kind glyph with its extension. */
function TileFace({ entry: e }: { entry: FileEntry }) {
  const dir = isDirLike(e);
  const image = e.preview === "image" && THUMBABLE.test(e.name);
  const video = e.preview === "video" && POSTERABLE.test(e.name);
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const poster = useVideoPoster(video ? `${e.path}:${e.mtime}` : null, rawUrl(e.path));
  if (dir) {
    return (
      <span className={s.faceFolder}>
        <FolderGlyph className={s.folderGlyph} link={e.type === "symlink"} />
      </span>
    );
  }
  if (image && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={s.faceImg} data-loaded={loaded ? "" : undefined} src={thumbUrl(e)} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />;
  }
  if (video && poster) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.faceImg} data-loaded="" src={poster} alt="" />
        <span className={s.faceBadge} aria-hidden>
          <MediaVideo />
        </span>
      </>
    );
  }
  const ext = extOf(e.name);
  return (
    <span className={s.faceKind}>
      <KindIcon kind={e.kind} type={e.type} className={s.tileGlyph} />
      {ext && <span className={s.faceExt}>{ext}</span>}
    </span>
  );
}

const Tile = React.memo(function Tile(p: ItemProps & { height: number }) {
  const { dir, common } = useItem(p);
  const e = p.entry;
  return (
    <div className={s.tile} role="gridcell" style={{ height: p.height }} aria-label={e.name} {...common}>
      <div className={s.thumb} data-dir={dir ? "" : undefined}>
        <TileFace entry={e} />
        <span className={s.tileCheck}>
          <Checkbox checked={p.selected} onChange={() => p.onToggle(p.index)}>
            <span className="sr-only">Select {e.name}</span>
          </Checkbox>
        </span>
      </div>
      <div className={s.tileText}>
        {p.renaming ? (
          <RenameInput entry={e} initial={p.renameDraft} onCommit={p.onRenameCommit} onCancel={p.onRenameCancel} />
        ) : (
          <span className={s.tileName} title={e.name} data-hidden={e.hidden ? "" : undefined}>
            {e.name}
          </span>
        )}
        <span className={`${s.tileSub} num`}>
          {e.link?.broken ? (
            "Broken link"
          ) : (
            <>
              <SizeValue p={p} dir={dir} compact />
              {" · "}
              <Time ts={e.mtime} />
            </>
          )}
        </span>
      </div>
    </div>
  );
});

/** Rename in place. The name is selected without its extension, so typing replaces just the name. */
function RenameInput({ entry, initial, onCommit, onCancel }: { entry: FileEntry; initial?: string | null; onCommit: (e: FileEntry, name: string) => void; onCancel: () => void }) {
  const [value, setValue] = React.useState(initial || entry.name);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (!v || v === entry.name) onCancel();
    else onCommit(entry, v);
  };
  return (
    <input
      className={s.renameInput}
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
