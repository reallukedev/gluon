"use client";
import * as React from "react";
import { ApiError, streamPost } from "@/lib/client/api";
import { fold } from "@/lib/search-match";
import type { SearchEvent } from "@/lib/search-types";
import { beginStream, reduceStream, type StreamState } from "./paletteModel";

const DEBOUNCE_MS = 70;
const CACHE_MS = 30_000;
const CACHE_MAX = 60;

/**
 * Ask the server as you type and keep each group as it streams in. A new query cancels the one in
 * flight; finished answers are kept for half a minute so backspacing is instant.
 */
export function usePaletteSearch(open: boolean, term: string, scope: string): StreamState | null {
  const [state, setState] = React.useState<StreamState | null>(null);
  const latest = React.useRef<StreamState | null>(null);
  const cache = React.useRef(new Map<string, { at: number; state: StreamState }>());

  const q = term.trim();
  const folded = fold(q);

  React.useEffect(() => {
    if (!open) {
      latest.current = null;
      setState(null);
      return;
    }
    // One letter is answered by the palette itself; the server starts at two.
    if (folded.length < 2) {
      latest.current = null;
      setState(null);
      return;
    }
    const key = `${scope}\n${folded}`;
    const hit = cache.current.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      latest.current = hit.state;
      setState(hit.state);
      return;
    }
    let acc = beginStream(latest.current, q, scope);
    latest.current = acc;
    setState(acc);
    const ctrl = new AbortController();
    const push = (next: StreamState) => {
      acc = next;
      latest.current = next;
      setState(next);
    };
    const timer = setTimeout(() => {
      streamPost<SearchEvent>(
        "/api/search",
        { q, scope },
        (e) => {
          if (ctrl.signal.aborted) return;
          push(reduceStream(acc, e));
          if (e.type === "done") {
            const c = cache.current;
            c.delete(key);
            c.set(key, { at: Date.now(), state: acc });
            if (c.size > CACHE_MAX) c.delete(c.keys().next().value!);
          }
        },
        ctrl.signal,
      ).catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        const message = e instanceof ApiError ? e.message : "Search isn't available right now. Check your connection.";
        push({ ...acc, done: true, pending: [], groups: acc.groups.filter((g) => !g.stale), error: message });
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `q` follows `folded`; searching again for a different spelling of the same words isn't needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folded, scope]);

  return state;
}

/** Recent searches, kept in this browser only (never on the server). */
export function useRecentSearches(userId: string) {
  const key = `gluon:palette:recent:${userId}`;
  const [list, setList] = React.useState<string[]>([]);
  React.useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
      setList(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []);
    } catch {
      setList([]);
    }
  }, [key]);
  const write = React.useCallback(
    (next: string[]) => {
      setList(next);
      try {
        if (next.length) localStorage.setItem(key, JSON.stringify(next));
        else localStorage.removeItem(key);
      } catch {
        /* private mode, storage full */
      }
    },
    [key],
  );
  const remember = React.useCallback(
    (term: string) => {
      const t = term.trim().slice(0, 80);
      if (t.length < 2) return;
      setList((cur) => {
        const next = [t, ...cur.filter((x) => fold(x) !== fold(t))].slice(0, 6);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  const clear = React.useCallback(() => write([]), [write]);
  return { recent: list, remember, clear };
}
