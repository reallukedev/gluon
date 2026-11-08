"use client";
import * as React from "react";
import type { FlowSource } from "./SourceStep";

export interface SourceInputs {
  image: string;
  run: string;
  compose: string;
  composeIcon: string | null;
  repo: string;
  branch: string;
  path: string;
  names: Partial<Record<FlowSource, string>>;
}

const EMPTY: SourceInputs = { image: "", run: "", compose: "", composeIcon: null, repo: "", branch: "", path: "", names: {} };
const KEY = "gluon.newApp.source";

export function clearSourceInputs() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}

/** Lifted above the source forms so switching sources keeps what was typed in each. */
export function useSourceInputs() {
  const [inputs, setInputs] = React.useState<SourceInputs>(EMPTY);
  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as Partial<SourceInputs>;
      const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
      setInputs({
        image: str(v.image, 300),
        run: str(v.run, 32_000),
        compose: str(v.compose, 256 * 1024),
        composeIcon: typeof v.composeIcon === "string" ? v.composeIcon : null,
        repo: str(v.repo, 300),
        branch: str(v.branch, 200),
        path: str(v.path, 300),
        names: v.names && typeof v.names === "object" ? Object.fromEntries(Object.entries(v.names).filter(([, n]) => typeof n === "string")) : {},
      });
    } catch {
      /* start empty */
    }
  }, []);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = React.useCallback((patch: Partial<SourceInputs>) => {
    setInputs((cur) => {
      const next = { ...cur, ...patch, names: { ...cur.names, ...patch.names } };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        try {
          window.sessionStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          /* too big or private mode: kept until the page closes */
        }
      }, 300);
      return next;
    });
  }, []);
  return { inputs, set };
}

export type SourceIO = ReturnType<typeof useSourceInputs>;
