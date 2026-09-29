"use client";
import * as React from "react";
import { EditPencil, Folder, MoreHoriz, NavArrowRight } from "iconoir-react";
import type { Listing, Place } from "@/lib/files-types";
import { api } from "@/lib/client/api";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { baseName, parentOf, useDropTarget } from "./lib";
import s from "./files.module.css";

interface Crumb {
  name: string;
  path: string;
}

interface Props {
  crumbs: Crumb[];
  path: string;
  /** Named places (drives, home folders, shares): a crumb at one of them shows its human name. */
  places?: Place[];
  /** Phone width: show only where you are and its parent; the rest folds into a menu. */
  compact?: boolean;
  /** Include hidden folders in the menus and suggestions. */
  hidden?: boolean;
  canDrop: boolean;
  onNavigate: (p: string) => void;
  onDropItems: (sources: string[], dest: string, copy: boolean) => void;
}

// ---------------------------------------------------------------- sub-folder lists (menus, completion)

const dirCache = new Map<string, { at: number; names: string[] | null; more: number }>();

async function subfolders(dir: string, hidden: boolean): Promise<{ names: string[] | null; more: number }> {
  const key = `${hidden ? 1 : 0}${dir}`;
  const hit = dirCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const q = new URLSearchParams({ path: dir, only: "dirs", sort: "name", limit: "400" });
  if (hidden) q.set("hidden", "1");
  let v: { names: string[] | null; more: number };
  try {
    const l = await api.get<Listing>(`/api/files/list?${q}`);
    v = { names: l.entries.map((e) => e.name), more: Math.max(0, l.total - l.entries.length) };
  } catch {
    v = { names: null, more: 0 };
  }
  dirCache.set(key, { at: Date.now(), ...v });
  if (dirCache.size > 60) dirCache.delete(dirCache.keys().next().value!);
  return v;
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** The folders a place-like crumb can be named after (drive labels, people's names, shares). */
const NAMED: Place["kind"][] = ["drive", "home", "data", "media", "grant"];

function friendlyCrumbs(crumbs: Crumb[], places: Place[] | undefined): (Crumb & { place?: boolean })[] {
  if (!places?.length || crumbs[0]?.path !== "/") return crumbs;
  // The deepest crumb that is a named place (and whose name says more than its folder name).
  for (let i = crumbs.length - 1; i > 0; i--) {
    const p = places.find((pl) => NAMED.includes(pl.kind) && pl.path === crumbs[i]!.path && pl.label !== crumbs[i]!.name);
    if (p) return [crumbs[0]!, { name: p.label, path: p.path, place: true }, ...crumbs.slice(i + 1)];
  }
  return crumbs;
}

/**
 * Where you are, as a row of folders you can click or drop things onto. Each chevron opens the
 * folders beside the next step; the pencil (or a click on the empty part) lets you type a path
 * with completion.
 */
export function PathBar({ crumbs: raw, path, places, compact, hidden = false, canDrop, onNavigate, onDropItems }: Props) {
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => setEditing(false), [path]);

  if (editing) return <PathInput path={path} hidden={hidden} onNavigate={onNavigate} onClose={() => setEditing(false)} />;

  const crumbs = friendlyCrumbs(raw, places);
  const keep = compact ? 2 : 3;
  const collapsed = crumbs.length > (compact ? keep : keep + 1);
  // What's drawn, in order: crumbs, and (when the path is long) one "…" holding the folders in between.
  type Seg = { kind: "crumb"; crumb: Crumb & { place?: boolean } } | { kind: "fold"; crumbs: Crumb[] };
  let segs: Seg[] = crumbs.map((c) => ({ kind: "crumb", crumb: c }));
  if (collapsed) {
    const tail = crumbs.slice(-(keep - (compact ? 0 : 1)));
    const folded = compact ? crumbs.slice(0, -keep) : crumbs.slice(1, -(keep - 1));
    segs = [...(compact ? [] : [{ kind: "crumb" as const, crumb: crumbs[0]! }]), { kind: "fold", crumbs: folded }, ...tail.map((c) => ({ kind: "crumb" as const, crumb: c }))];
  }
  const pathOf = (g: Seg) => (g.kind === "crumb" ? g.crumb.path : g.crumbs[0]!.path);

  return (
    <div
      className={s.pathBar}
      onClick={(e) => {
        if (e.target === e.currentTarget) setEditing(true);
      }}
    >
      <nav aria-label="Folder path" className={s.crumbs}>
        {segs.map((g, i) => (
          <React.Fragment key={g.kind === "crumb" ? g.crumb.path : "fold"}>
            {/* The chevron before a step lists the folders beside it (inside its parent). */}
            {i > 0 && <SiblingMenu dir={parentOf(pathOf(g))} current={pathOf(g)} hidden={hidden} onNavigate={onNavigate} />}
            {g.kind === "fold" ? (
              <FoldedMenu crumbs={g.crumbs} onNavigate={onNavigate} />
            ) : (
              <CrumbButton crumb={g.crumb} last={i === segs.length - 1} canDrop={canDrop} onNavigate={onNavigate} onDropItems={onDropItems} />
            )}
          </React.Fragment>
        ))}
      </nav>
      <button type="button" className={s.pathEdit} onClick={() => setEditing(true)} aria-label="Type a path">
        <EditPencil />
      </button>
    </div>
  );
}

function FoldedMenu({ crumbs, onNavigate }: { crumbs: Crumb[]; onNavigate: (p: string) => void }) {
  return (
    <Menu
      align="start"
      trigger={
        <button type="button" className={s.crumb} aria-label="Show the folders in between">
          <MoreHoriz />
        </button>
      }
      items={crumbs.map((h) => ({ label: h.name, icon: <Folder />, onSelect: () => onNavigate(h.path) }))}
    />
  );
}

/** The chevron between two crumbs: opens the folders inside `dir`, the current one ticked. */
function SiblingMenu({ dir, current, hidden, onNavigate }: { dir: string; current: string; hidden: boolean; onNavigate: (p: string) => void }) {
  const [list, setList] = React.useState<{ names: string[] | null; more: number } | "loading" | null>(null);
  const load = () => {
    if (list && list !== "loading") return;
    setList("loading");
    void subfolders(dir, hidden).then(setList);
  };
  React.useEffect(() => setList(null), [dir, hidden]);
  let items: MenuEntry[];
  if (!list || list === "loading") items = [{ label: "Loading…", disabled: true }];
  else if (!list.names) items = [{ label: "Couldn't list this folder", disabled: true }];
  else if (!list.names.length) items = [{ label: "No folders inside", disabled: true }];
  else {
    items = list.names.map((n) => {
      const p = join(dir, n);
      return p === current ? { kind: "check" as const, label: n, checked: true, onChange: () => onNavigate(p) } : { label: n, onSelect: () => onNavigate(p) };
    });
    if (list.more) items.push("separator", { label: `${list.more.toLocaleString()} more — type the path to reach them`, disabled: true });
  }
  return (
    <Menu
      align="start"
      trigger={
        <button type="button" className={s.crumbSepBtn} aria-label={`Folders in ${baseName(dir) === "/" ? "Computer" : baseName(dir)}`} onPointerEnter={load} onFocus={load} onPointerDown={load}>
          <NavArrowRight />
        </button>
      }
      items={items}
    />
  );
}

function CrumbButton({ crumb, last, canDrop, onNavigate, onDropItems }: { crumb: Crumb & { place?: boolean }; last: boolean; canDrop: boolean; onNavigate: (p: string) => void; onDropItems: (sources: string[], dest: string, copy: boolean) => void }) {
  const drop = useDropTarget(last ? null : crumb.path, onDropItems, canDrop);
  return (
    <button
      type="button"
      className={s.crumb}
      aria-current={last ? "location" : undefined}
      data-drop={drop.over ? "" : undefined}
      onClick={() => !last && onNavigate(crumb.path)}
      title={crumb.path}
      {...drop.props}
    >
      <span className="truncate">{crumb.name}</span>
    </button>
  );
}

// ---------------------------------------------------------------- typing a path

/** A path field that completes folder names: Tab takes the highlighted one, arrows move, Enter goes. */
function PathInput({ path, hidden, onNavigate, onClose }: { path: string; hidden: boolean; onNavigate: (p: string) => void; onClose: () => void }) {
  const [value, setValue] = React.useState(path === "/" ? "/" : `${path}/`);
  const [error, setError] = React.useState<string | null>(null);
  const [hits, setHits] = React.useState<string[]>([]);
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();

  const dir = value.endsWith("/") ? value.replace(/\/+$/, "") || "/" : parentOf(value);
  const stem = value.endsWith("/") ? "" : baseName(value).toLowerCase();

  React.useEffect(() => {
    if (!value.startsWith("/")) return setHits([]);
    let live = true;
    const t = setTimeout(() => {
      void subfolders(dir, hidden || stem.startsWith(".")).then((r) => {
        if (!live) return;
        const names = r.names ?? [];
        const starts = names.filter((n) => n.toLowerCase().startsWith(stem));
        const inside = stem ? names.filter((n) => !n.toLowerCase().startsWith(stem) && n.toLowerCase().includes(stem)) : [];
        const next = [...starts, ...inside].filter((n) => join(dir, n) !== value.replace(/\/+$/, "")).slice(0, 8);
        setHits(next);
        setActive(-1);
      });
    }, 90);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [dir, stem, hidden, value]);

  const complete = (name: string) => {
    setValue(`${join(dir, name)}/`);
    setError(null);
  };
  const go = (p: string) => {
    const v = p.trim();
    if (!v.startsWith("/")) return setError("Paths start with / — for example /mnt/media.");
    if (v.includes("\0")) return setError("That path has characters Gluon can't use.");
    onClose();
    onNavigate(v.length > 1 ? v.replace(/\/+$/, "") : v);
  };

  return (
    <form
      className={s.pathForm}
      onSubmit={(e) => {
        e.preventDefault();
        go(active >= 0 && hits[active] ? join(dir, hits[active]!) : value);
      }}
    >
      <input
        className={`${s.pathInput} mono`}
        autoFocus
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="go"
        aria-label="Folder path"
        aria-invalid={!!error}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => !error && onClose()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown" && hits.length) {
            e.preventDefault();
            setActive((a) => (a + 1) % hits.length);
          } else if (e.key === "ArrowUp" && hits.length) {
            e.preventDefault();
            setActive((a) => (a <= 0 ? hits.length - 1 : a - 1));
          } else if (e.key === "Tab" && !e.shiftKey && hits.length) {
            e.preventDefault();
            complete(hits[Math.max(0, active)]!);
          }
        }}
      />
      {hits.length > 0 && (
        <ul className={s.pathHints} id={listId} role="listbox" aria-label="Folders">
          {hits.map((n, i) => (
            <li
              key={n}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={s.pathHint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(join(dir, n))}
              onMouseEnter={() => setActive(i)}
            >
              <Folder aria-hidden />
              <span className="truncate mono">{n}</span>
            </li>
          ))}
          <li className={s.pathHintFoot} aria-hidden>
            <kbd>Tab</kbd> completes · <kbd>↵</kbd> opens
          </li>
        </ul>
      )}
      {error && (
        <span className={s.pathError} role="alert">
          <i className={s.errorMark} aria-hidden />
          {error}
        </span>
      )}
    </form>
  );
}
