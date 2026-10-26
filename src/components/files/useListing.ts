"use client";
import * as React from "react";
import { api, useApi, type ApiError } from "@/lib/client/api";
import type { FileEntry, Listing, SortKey } from "@/lib/files-types";

export const PAGE = 500;

export interface ListingParams {
  path: string | null;
  sort: SortKey;
  order: "asc" | "desc";
  hidden: boolean;
  filter: string;
}

function url(p: ListingParams, offset: number) {
  const q = new URLSearchParams({ path: p.path ?? "/", sort: p.sort, order: p.order, offset: String(offset), limit: String(PAGE) });
  if (p.hidden) q.set("hidden", "1");
  if (p.filter) q.set("filter", p.filter);
  return `/api/files/list?${q}`;
}

/**
 * A folder listing loaded page by page (500 entries each) as rows scroll into view, so a 100k-entry
 * folder never loads at once. Page 0 carries the folder's metadata and is kept fresh by SWR.
 */
export function useListing(p: ListingParams) {
  const first = useApi<Listing>(p.path ? url(p, 0) : null, { keepPreviousData: false, revalidateOnFocus: true, shouldRetryOnError: false });
  const key = p.path ? url(p, 0) : "";
  const [extra, setExtra] = React.useState<{ key: string; pages: Map<number, FileEntry[]> }>({ key, pages: new Map() });
  const loading = React.useRef(new Set<string>());
  const pages = extra.key === key ? extra.pages : new Map<number, FileEntry[]>();

  const listing = first.data && first.data.path ? first.data : undefined;
  const total = listing?.total ?? 0;

  const rows = React.useMemo(() => {
    const out: (FileEntry | undefined)[] = new Array(total);
    if (listing) listing.entries.forEach((e, i) => (out[i] = e));
    for (const [n, list] of pages) list.forEach((e, i) => (out[n * PAGE + i] = e));
    return out;
  }, [listing, pages, total]);

  const ensure = React.useCallback(
    (index: number) => {
      if (!p.path || !listing) return;
      const n = Math.floor(index / PAGE);
      if (n === 0 || pages.has(n)) return;
      const tag = `${key}#${n}`;
      if (loading.current.has(tag)) return;
      loading.current.add(tag);
      api
        .get<Listing>(url(p, n * PAGE))
        .then((l) =>
          setExtra((cur) => {
            const base = cur.key === key ? cur.pages : new Map<number, FileEntry[]>();
            const next = new Map(base);
            next.set(n, l.entries);
            return { key, pages: next };
          }),
        )
        .catch(() => {})
        .finally(() => loading.current.delete(tag));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, listing, pages],
  );

  /** Load every page (for select-all / conflict checks), up to `max` entries. */
  const loadAll = React.useCallback(
    async (max = 20_000): Promise<FileEntry[]> => {
      if (!listing) return [];
      const n = Math.ceil(Math.min(total, max) / PAGE);
      const got = new Map(pages);
      await Promise.all(
        Array.from({ length: n }, (_, i) => i)
          .filter((i) => i > 0 && !got.has(i))
          .map(async (i) => got.set(i, (await api.get<Listing>(url(p, i * PAGE))).entries)),
      );
      setExtra({ key, pages: got });
      const all: FileEntry[] = [...listing.entries];
      for (let i = 1; i < n; i++) all.push(...(got.get(i) ?? []));
      return all;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, listing, pages, total],
  );

  const refresh = React.useCallback(async () => {
    const loaded = [...pages.keys()];
    await first.mutate();
    if (!loaded.length) return;
    const fresh = new Map<number, FileEntry[]>();
    await Promise.all(loaded.map(async (n) => fresh.set(n, (await api.get<Listing>(url(p, n * PAGE)).catch(() => ({ entries: [] as FileEntry[] }))).entries)));
    setExtra({ key, pages: fresh });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.mutate, pages, key]);

  return {
    listing,
    rows,
    total,
    ensure,
    loadAll,
    refresh,
    error: first.error as ApiError | undefined,
    isLoading: !listing && !first.error,
    isValidating: first.isValidating,
  };
}
