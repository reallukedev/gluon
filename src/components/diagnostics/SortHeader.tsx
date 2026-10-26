"use client";
import { ArrowDown, ArrowUp } from "iconoir-react";
import s from "./diagnostics.module.css";

export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

/** A column header that sorts; clicking the active one flips the direction. */
export function SortHeader<K extends string>({ label, k, sort, onSort, align }: { label: string; k: K; sort: SortState<K>; onSort: (s: SortState<K>) => void; align?: "end" }) {
  const active = sort.key === k;
  return (
    <span role="columnheader" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={align === "end" ? s.end : undefined}>
      <button
        type="button"
        className={s.sortBtn}
        data-active={active ? "" : undefined}
        onClick={() => onSort({ key: k, dir: active ? (sort.dir === "asc" ? "desc" : "asc") : k === ("name" as K) ? "asc" : "desc" })}
      >
        {label}
        {active && (sort.dir === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
      </button>
    </span>
  );
}
