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
  /** Scroll to and focus this path once it's loaded (after create/rename/upload). */
  reveal: string | null;
  /** Folder that files dragged in from the computer would be uploaded into (highlighted). */
  dropPath?: string | null;
  /** The Owner column (the Linux user): admins only; it means nothing to a household member. */
  showOwner?: boolean;
}

const GRID_MIN = 156;
const GRID_GAP = 12;

function cssPx(name: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The folder contents: a virtualised list or grid over the window scroll, with multi-select
 * (click, ⇧-click ranges, ⌘/Ctrl-click, checkboxes), keyboard navigation, a context menu, and
 * dragging items onto folders to move them.
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
    if (renaming || (ev.target as HTMLElement).closest("input,button,[role=menuitem]")) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const cur = rows[focus];
    const step = view === "grid" ? cols : 1;
    switch (ev.key) {
      case "ArrowDown":
        if (mod && cur) props.onOpen(cur);
        else moveFocus(focus + step, ev.shiftKey);
        break;
      case "ArrowUp":
        if (mod) props.onUp();
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
      case "Enter":
        if (cur) props.onOpen(cur);
        break;
      case " ":
        if (cur && !isDirLike(cur)) props.onPreview(cur);
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
      case "a":
      case "A":
        if (!mod) return;
        props.onSelectAll();
        break;
      case "Escape":
        if (!selected.size) return;
        setSelected(new Set());
        break;
      default: {
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
  };
  const loadedCount = rows.filter(Boolean).length;
  const allSelected = loadedCount > 0 && selected.size >= loadedCount;
  const active = rows[focus];

  const body = (
    <div
      ref={wrap}
      className={s.listing}
      data-owner={props.showOwner ? "" : undefined}
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
                    writable={writable}
                    selectedPaths={selected}
                    osDrop={dropPath === e.path}
                    onSelect={selectIndex}
                    onToggle={toggle}
                    {...handlers}
                  />
                ) : (
                  <div className={s.row} aria-hidden>
                    <span />
                    <Skeleton width={`${30 + ((it.index * 37) % 50)}%`} />
                  </div>
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
                    writable={writable}
                    selectedPaths={selected}
                    osDrop={dropPath === e.path}
                    onSelect={selectIndex}
                    onToggle={toggle}
                    height={lineH - GRID_GAP}
                    {...handlers}
                  />
                ) : (
                  <Skeleton key={c} height={lineH - GRID_GAP} radius={10} />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );

  return <ContextMenu items={ctxItems}>{body}</ContextMenu>;
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
  onSelect: (i: number, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  onToggle: (i: number) => void;
}

function useItem(p: ItemProps) {
  const dir = isDirLike(p.entry);
  const drop = useDropTarget(dir && !p.entry.link?.outside ? p.entry.path : null, p.onDropItems, p.writable);
  const common = {
    id: `row-${p.index}`,
    "data-index": p.index,
    "aria-selected": p.selected,
    "data-focused": p.focused ? "" : undefined,
    "data-drop": drop.over || p.osDrop ? "" : undefined,
    draggable: p.writable && !p.renaming,
    onDragStart: (ev: React.DragEvent) => {
      const paths = p.selectedPaths.has(p.entry.path) ? [...p.selectedPaths] : [p.entry.path];
      ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      ev.dataTransfer.effectAllowed = "copyMove";
    },
    onClick: (ev: React.MouseEvent) => {
      if ((ev.target as HTMLElement).closest("button,input,a,[role=checkbox]")) return;
      // On touch screens a tap opens (like a phone's file app) unless you're selecting.
      const touch = (ev.nativeEvent as PointerEvent).pointerType === "touch";
      if (touch && !p.selectedPaths.size) return p.onOpen(p.entry);
      if (touch) return p.onToggle(p.index);
      p.onSelect(p.index, ev);
    },
    onDoubleClick: (ev: React.MouseEvent) => {
      if ((ev.target as HTMLElement).closest("button,input,[role=checkbox]")) return;
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

const Row = React.memo(function Row(p: ItemProps) {
  const fmt = useFormat();
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
          <RenameInput entry={e} onCommit={p.onRenameCommit} onCancel={p.onRenameCancel} />
        ) : (
          <span className={s.nameText}>
            <span className="truncate" title={e.name}>
              {e.name}
            </span>
            {e.link && (
              <span className={s.linkNote} title={`Link to ${e.link.target}`} data-broken={e.link.broken ? "" : undefined}>
                {e.link.broken ? "broken link" : `→ ${e.link.target}`}
              </span>
            )}
          </span>
        )}
        <span className={`${s.mobileMeta} num`}>
          {dir ? (e.dirSize ? fmt.bytes(e.dirSize.bytes) : "Folder") : fmt.bytes(e.size)} · <Time ts={e.mtime} />
        </span>
      </span>
      <span role="gridcell" className={`${s.sizeCol} num`}>
        {!dir ? (
          fmt.bytes(e.size)
        ) : e.dirSize ? (
          <span title={`Measured ${fmt.relative(e.dirSize.computedAt)}`}>{fmt.bytes(e.dirSize.bytes)}</span>
        ) : (
          <button type="button" className={s.calc} onClick={() => p.onCalculate(e)} aria-label={`Calculate the size of ${e.name}`}>
            <span className={s.calcDash}>—</span>
            <span className={s.calcLabel}>Calculate</span>
          </button>
        )}
      </span>
      <span role="gridcell" className={`${s.dateCol} num`}>
        <Time ts={e.mtime} />
      </span>
      <span role="gridcell" className={`${s.ownerCol} truncate`} title={`${e.owner ?? e.uid}:${e.group ?? e.gid} ${e.mode}`}>
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
    return <img className={s.faceImg} data-loaded={loaded ? "" : undefined} src={thumbUrl(e)} alt="" loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />;
  }
  if (video && poster) {
    return (
      <>
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
  const fmt = useFormat();
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
          <RenameInput entry={e} onCommit={p.onRenameCommit} onCancel={p.onRenameCancel} />
        ) : (
          <span className={s.tileName} title={e.name} data-hidden={e.hidden ? "" : undefined}>
            {e.name}
          </span>
        )}
        <span className={`${s.tileSub} num`}>
          {dir ? (e.dirSize ? fmt.bytes(e.dirSize.bytes) : e.link ? "Link to a folder" : "Folder") : fmt.bytes(e.size)}
          {" · "}
          <Time ts={e.mtime} />
        </span>
      </div>
    </div>
  );
});

function RenameInput({ entry, onCommit, onCancel }: { entry: FileEntry; onCommit: (e: FileEntry, name: string) => void; onCancel: () => void }) {
  const [value, setValue] = React.useState(entry.name);
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
      onFocus={(ev) => {
        const dot = entry.name.lastIndexOf(".");
        ev.currentTarget.setSelectionRange(0, dot > 0 && !isDirLike(entry) ? dot : entry.name.length);
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
    />
  );
}
