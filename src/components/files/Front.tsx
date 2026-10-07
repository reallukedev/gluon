"use client";
import * as React from "react";
import { NavArrowRight } from "iconoir-react";
import type { Place, SearchHit } from "@/lib/files-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { DiskGlyph } from "@/components/storage/DiskGlyph";
import { collectionRoots, useFileSearch, type SearchSpec, type SearchState } from "./hooks";
import { fullness, groupPlaces, type PlaceGroup } from "./logic";
import { useFiles } from "./Files";
import { FileTime } from "./FileTime";
import { SizeRule } from "./PreviewBody";
import { Thumb, type ThumbItem } from "./Thumb";
import { PlaceIcon, baseName, parentOf, thumbUrl } from "./lib";
import s from "./front.module.css";

// The front page: what you keep, by what it is, across every drive. Collections load one after
// another (so they don't crowd the connection), places sit in a rack with their meters, and
// anything opens in quick look or in its folder.

const COVER = /^(poster|cover|folder|front)\.(jpe?g|png|webp)$/i;
/** Where apps and backups keep their own files (caches, databases, repositories): not anyone's photos or films. */
const APP_STUFF = /\/(appdata|app-data|cache|caches|config|metadata|transcodes?|thumbnails?|postgres|pgdata|restic|borg|\.[^/]+)\//i;
const personal = (h: SearchHit) => !APP_STUFF.test(h.path) && !h.name.startsWith(".");

type Shelf = "recent" | "photos" | "videos" | "large" | "documents";
const SHELVES: { id: Shelf; spec: (roots: string[]) => SearchSpec }[] = [
  { id: "recent", spec: (roots) => ({ roots, q: "*", type: "file", modifiedWithinDays: 14, limit: 300 }) },
  { id: "photos", spec: (roots) => ({ roots, q: "*", kinds: ["image"], limit: 600 }) },
  { id: "videos", spec: (roots) => ({ roots, q: "*", kinds: ["video"], limit: 400 }) },
  { id: "large", spec: (roots) => ({ roots, q: "*", type: "file", minSize: 1e9, limit: 300 }) },
  { id: "documents", spec: (roots) => ({ roots, q: "*", kinds: ["document"], limit: 300 }) },
];

export const Front = React.memo(function Front() {
  const f = useFiles();
  const roots = React.useMemo(() => collectionRoots(f.places), [f.places]);
  const [step, setStep] = React.useState(0);
  // Once places are known, an empty list of roots (nothing searchable) still gets a spec, which
  // finishes at once with nothing found; shelves waiting their turn stay null and show as loading.
  const specs = SHELVES.map((sh, i) => (f.places && i <= step ? sh.spec(roots) : null));
  const recent = useFileSearch(specs[0]!, CACHED);
  const photos = useFileSearch(specs[1]!, CACHED);
  const videos = useFileSearch(specs[2]!, CACHED);
  const large = useFileSearch(specs[3]!, CACHED);
  const documents = useFileSearch(specs[4]!, CACHED);
  const list = [recent, photos, videos, large, documents];
  React.useEffect(() => {
    if (step < list.length - 1 && specs[step] && (list[step]!.done || list[step]!.error)) setStep(step + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, list[step]?.done]);

  return (
    <div className={s.front} data-files-keys="">
      <Shelf title="Changed in the last two weeks" state={recent} sort="mtime" empty="Nothing new or changed in the last two weeks." />
      <PlacesRack />
      <Shelf title="Photos" state={photos} sort="mtime" filter={(h) => !COVER.test(h.name)} empty="No photos in the folders you can open yet." />
      <Shelf title="Films and shows" state={videos} sort="name" covers={photos.hits} group empty="No videos found." />
      <Largest state={large} />
      <Shelf title="Documents" state={documents} sort="mtime" empty="No documents found." />
    </div>
  );
});

const CACHED = { cache: true };

const asThumb = (h: SearchHit): ThumbItem => ({ path: h.path, name: h.name, kind: h.kind, type: h.type, size: h.size, mtime: h.mtime });

function Shelf({ title, state, sort, filter, covers, group, empty }: { title: string; state: SearchState & { retry: () => void }; sort: "mtime" | "name"; filter?: (h: SearchHit) => boolean; covers?: SearchHit[]; group?: boolean; empty: string }) {
  const f = useFiles();
  const fmt = useFormat();
  const [all, setAll] = React.useState(false);
  const id = React.useId();
  let hits = state.hits.filter((h) => h.type === "file" && personal(h) && (!filter || filter(h)));
  hits = sort === "mtime" ? hits.toSorted((a, b) => b.mtime - a.mtime) : hits.toSorted((a, b) => a.path.localeCompare(b.path));
  // A show's episodes are one tile (its folder); a film is its own tile, with its poster.
  type Tile = { item: ThumbItem; cover: string | null; sub: React.ReactNode; hit?: SearchHit };
  const coverFor = (dir: string) => {
    const c = covers?.find((x) => COVER.test(x.name) && parentOf(x.path) === dir);
    return c ? thumbUrl(c, 320) : null;
  };
  let tiles: Tile[];
  if (group) {
    const byShow = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const dir = parentOf(h.path);
      const show = /^season\s*\d+$/i.test(baseName(dir)) ? parentOf(dir) : dir;
      byShow.set(show, [...(byShow.get(show) ?? []), h]);
    }
    tiles = [...byShow].map(([dir, l]) =>
      l.length > 1
        ? { item: { path: dir, name: baseName(dir), kind: "folder", type: "dir", size: null, mtime: Math.max(...l.map((x) => x.mtime)) }, cover: coverFor(dir), sub: fmt.plural(l.length, "episode") }
        : { item: asThumb(l[0]!), cover: coverFor(parentOf(l[0]!.path)), sub: fmt.bytes(l[0]!.size), hit: l[0]! },
    );
  } else tiles = hits.map((h) => ({ item: asThumb(h), cover: null, sub: sort === "mtime" ? <FileTime ts={h.mtime} /> : fmt.bytes(h.size), hit: h }));
  const shown = all ? tiles : tiles.slice(0, 24);
  const siblings = tiles.flatMap((t) => (t.hit ? [t.hit] : []));
  const loading = !state.done && !state.hits.length;
  const open = (t: Tile) => (t.item.kind === "folder" ? f.go(t.item.path) : t.hit && f.lookHit(t.hit, siblings));
  const reveal = (t: Tile) => f.go(t.item.kind === "folder" ? t.item.path : parentOf(t.item.path), t.item.kind === "folder" ? {} : { select: t.item.name });
  return (
    <section className={s.shelf} aria-labelledby={id}>
      <div className={s.head}>
        <h2 className={s.title} id={id}>
          {title}
        </h2>
        <span className={`${s.count} num`}>{state.done && tiles.length ? (state.truncated ? `${tiles.length}+` : tiles.length) : ""}</span>
        {tiles.length > 24 && (
          <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `See all ${tiles.length}`}
          </Button>
        )}
      </div>
      {state.error && (
        <Notice tone="fault" title="This collection couldn't load" action={<Button size="sm" onClick={state.retry}>Try again</Button>}>
          {state.error}
        </Notice>
      )}
      {state.done && !tiles.length && !state.error ? (
        <p className={s.empty}>{empty}</p>
      ) : (
        <div className={s.strip} data-all={all ? "" : undefined} role="list">
          {loading
            ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={group ? 300 : 172} radius={10} style={{ flex: "none", width: 168 }} />)
            : shown.map((t) => (
                <button
                  key={t.item.path}
                  type="button"
                  role="listitem"
                  className={s.tile}
                  onClick={() => open(t)}
                  onKeyDown={(e) => {
                    if (e.key === " ") {
                      e.preventDefault();
                      open(t);
                    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.altKey)) {
                      e.preventDefault();
                      reveal(t);
                    }
                  }}
                  title={`${t.item.path}\nSpace to look, ${t.item.kind === "folder" ? "Enter to open" : "Alt+Enter to show in its folder"}`}
                >
                  <span className={s.face} data-tall={group ? "" : undefined}>
                    <Thumb item={t.item} cover={t.cover} size={320} />
                  </span>
                  <span className={s.name}>{t.item.name}</span>
                  <span className={`${s.sub} num`}>{t.sub}</span>
                </button>
              ))}
        </div>
      )}
    </section>
  );
}

/** What's taking the space: the biggest files anywhere, each with a size rule and a way to its folder. */
function Largest({ state }: { state: SearchState & { retry: () => void } }) {
  const f = useFiles();
  const fmt = useFormat();
  const hits = state.hits.filter((h) => h.size !== null).toSorted((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const total = hits.reduce((a, h) => a + (h.size ?? 0), 0);
  const max = hits[0]?.size ?? 0;
  return (
    <section className={s.shelf} aria-label="Taking the most space">
      <div className={s.head}>
        <h2 className={s.title}>Taking the most space</h2>
        {state.done && hits.length > 0 && (
          <span className={`${s.count} num`}>
            {fmt.plural(hits.length, "file")} over 1 GB, {fmt.bytes(total)} together
          </span>
        )}
      </div>
      {state.error ? (
        <Notice tone="fault" title="This list couldn't load" action={<Button size="sm" onClick={state.retry}>Try again</Button>}>
          {state.error}
        </Notice>
      ) : !state.done && !hits.length ? (
        <Skeleton height={180} radius={12} />
      ) : !hits.length ? (
        <p className={s.empty}>No single file is over 1 GB.</p>
      ) : (
        <ol className={s.ledger}>
          {hits.slice(0, 10).map((h) => (
            <li key={h.path}>
              <button type="button" className={s.ledgerRow} onClick={() => f.go(parentOf(h.path), { select: h.name })} title={`Show ${h.name} in its folder`}>
                <span className={s.ledgerName}>
                  <span className="truncate">{h.name}</span>
                  <span className="mono truncate">{parentOf(h.path)}</span>
                </span>
                <span className={`${s.ledgerSize} num`}>{fmt.bytes(h.size)}</span>
                <SizeRule share={max ? (h.size ?? 0) / max : null} className={s.ledgerRule} />
              </button>
              <IconButton label={`Show ${h.name} in its folder`} size="sm" onClick={() => f.go(parentOf(h.path), { select: h.name })}>
                <NavArrowRight />
              </IconButton>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const RACK_TITLE: Partial<Record<PlaceGroup, string>> = { shared: "Shared with you", pins: "Pinned", drives: "Drives", people: "People", apps: "Where apps keep files" };

function PlacesRack() {
  const f = useFiles();
  const fmt = useFormat();
  if (!f.places) return <Skeleton height={140} radius={12} />;
  const groups = groupPlaces(f.places).filter(([g]) => g !== "recent");
  return (
    <section className={s.rack} aria-label="Places">
      {groups.map(([g, list]) => (
        <div key={g} className={s.rackGroup}>
          <span className="label">{RACK_TITLE[g]}</span>
          <div className={s.rackRow}>
            {list
              .filter((p) => g !== "drives" || p.kind !== "root" || f.admin)
              .map((p) => (
                <PlatePlace key={p.id} p={p} fmt={fmt} onGo={(path) => f.go(path)} />
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function PlatePlace({ p, fmt, onGo }: { p: Place; fmt: ReturnType<typeof useFormat>; onGo: (p: string) => void }) {
  const drive = p.kind === "drive" || p.kind === "root";
  const missing = p.missing || (p.kind === "drive" && !p.fs);
  const level = drive && p.fs ? fullness(p.fs.used, p.fs.size) : null;
  const pct = p.fs?.size ? (p.fs.used / p.fs.size) * 100 : 0;
  return (
    <button type="button" className={s.plate} onClick={() => !missing && onGo(p.path)} title={p.path} data-missing={missing ? "" : undefined} aria-disabled={missing || undefined}>
      <span className={s.plateTop}>
        {drive ? <DiskGlyph media={p.media} className={s.plateIcon} /> : <PlaceIcon kind={p.kind} className={s.plateIcon} />}
        <span className="truncate">{p.label}</span>
      </span>
      {missing ? (
        <span className={s.plateSub}>Not connected. Its files come back when the drive does.</span>
      ) : level ? (
        <>
          <span className={s.meter} data-level={level} aria-hidden>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
          <span className={`${s.plateSub} num`}>
            {level === "fault" && <i className={s.faultMark} aria-hidden />}
            {level === "fault" ? "Nearly full: " : ""}
            {fmt.bytes(p.fs!.avail)} free of {fmt.bytes(p.fs!.size)}
          </span>
        </>
      ) : (
        <span className={`${s.plateSub} truncate`}>{p.kind === "grant" ? (p.access === "write" ? "You can add and change things" : "You can look and download") : (p.detail ?? p.path)}</span>
      )}
    </button>
  );
}
