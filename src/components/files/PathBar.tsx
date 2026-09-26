"use client";
import * as React from "react";
import { MoreHoriz, NavArrowRight, EditPencil } from "iconoir-react";
import { Menu } from "@/components/ui/Menu";
import { useDropTarget } from "./lib";
import s from "./files.module.css";

interface Crumb {
  name: string;
  path: string;
}

/** Clickable path segments (drop targets too); click the empty part of the bar to type a path. */
export function PathBar({ crumbs, path, canDrop, onNavigate, onDropItems }: { crumbs: Crumb[]; path: string; canDrop: boolean; onNavigate: (p: string) => void; onDropItems: (sources: string[], dest: string, copy: boolean) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(path);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setValue(path);
    setEditing(false);
    setError(null);
  }, [path]);

  if (editing) {
    return (
      <form
        className={s.pathForm}
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (!v.startsWith("/")) return setError("Paths start with / — for example /mnt/media.");
          if (v.includes("\0")) return setError("That path has characters Gluon can't use.");
          setEditing(false);
          onNavigate(v.length > 1 ? v.replace(/\/+$/, "") : v);
        }}
      >
        <input
          className={`${s.pathInput} mono`}
          autoFocus
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Folder path"
          aria-invalid={!!error}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => !error && setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setEditing(false);
              setValue(path);
            }
          }}
        />
        {error && (
          <span className={s.pathError} role="alert">
            {error}
          </span>
        )}
      </form>
    );
  }

  const collapsed = crumbs.length > 4;
  const shown = collapsed ? [crumbs[0]!, ...crumbs.slice(-2)] : crumbs;
  const hidden = collapsed ? crumbs.slice(1, -2) : [];

  return (
    <div
      className={s.pathBar}
      onClick={(e) => {
        if (e.target === e.currentTarget) setEditing(true);
      }}
    >
      <nav aria-label="Folder path" className={s.crumbs}>
        {shown.map((c, i) => (
          <React.Fragment key={c.path}>
            {i > 0 && <NavArrowRight className={s.crumbSep} aria-hidden />}
            {collapsed && i === 1 && (
              <>
                <Menu
                  align="start"
                  trigger={
                    <button type="button" className={s.crumb} aria-label="Show the folders in between">
                      <MoreHoriz />
                    </button>
                  }
                  items={hidden.map((h) => ({ label: h.name, onSelect: () => onNavigate(h.path) }))}
                />
                <NavArrowRight className={s.crumbSep} aria-hidden />
              </>
            )}
            <CrumbButton crumb={c} last={i === shown.length - 1} canDrop={canDrop} onNavigate={onNavigate} onDropItems={onDropItems} />
          </React.Fragment>
        ))}
      </nav>
      <button type="button" className={s.pathEdit} onClick={() => setEditing(true)} aria-label="Type a path">
        <EditPencil />
      </button>
    </div>
  );
}

function CrumbButton({ crumb, last, canDrop, onNavigate, onDropItems }: { crumb: Crumb; last: boolean; canDrop: boolean; onNavigate: (p: string) => void; onDropItems: (sources: string[], dest: string, copy: boolean) => void }) {
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
