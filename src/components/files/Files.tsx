"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { NavArrowLeft } from "iconoir-react";
import type { FileEntry, Listing as ListingT, Places, SearchHit, TrashSummary } from "@/lib/files-types";
import { useApi, type ApiError } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useFileActions, type FileActions } from "./actions";
import { clearSearchCache, folderSentence, folderTitle, inLightbox, statEntry } from "./hooks";
import { CommandBar } from "./CommandBar";
import { Front } from "./Front";
import { Browser, type BrowserApi } from "./Browser";
import { Lightbox } from "./Lightbox";
import { Preview } from "./Preview";
import { Shortcuts } from "./Shortcuts";
import { TrashView } from "./TrashView";
import { filesHref, isDirLike, joinPath, parentOf, useModKey } from "./lib";
import s from "./shell.module.css";

// Files: a front page of what you keep (Shelves), folders as columns or a grid (Browser), and one
// command bar on every screen to find, jump and act. This component owns where you are, what's
// selected, the shared actions and quick look; the screens draw.

export type Screen = "front" | "browse" | "trash";

export interface Selected {
  entries: FileEntry[];
  /** The folder they're in. */
  dir: string | null;
  writable: boolean;
}

interface FilesState {
  admin: boolean;
  places: Places | undefined;
  screen: Screen;
  path: string | null;
  /** Go to a folder (null for the front page). `select` names an item to land on inside it. */
  go: (path: string | null, opts?: { select?: string; replace?: boolean }) => void;
  openTrash: () => void;
  /** Full path of an item to land on once its folder is listed (from ?select= or a search result). */
  reveal: string | null;
  doneReveal: () => void;
  setSelection: (s: Selected) => void;
  setHere: (l: ListingT | undefined) => void;
  setHereError: (e: ApiError | null) => void;
  actions: FileActions;
  look: (e: FileEntry, siblings?: (FileEntry | SearchHit)[]) => void;
  lookHit: (h: SearchHit, siblings?: SearchHit[]) => void;
  /** Called after anything changes files, so every visible folder, the places and the trash refresh. */
  refresh: () => void;
  onRefresh: (fn: () => void) => () => void;
  browser: React.RefObject<BrowserApi | null>;
  showKeys: () => void;
}

/** What the bar needs to know about the folder on screen; changes as the selection does. */
interface BarState {
  here: ListingT | undefined;
  selection: Selected;
}
const BarCtx = React.createContext<BarState>({ here: undefined, selection: { entries: [], dir: null, writable: false } });
export const useBarState = () => React.useContext(BarCtx);

const Ctx = React.createContext<FilesState | null>(null);
export function useFiles() {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useFiles outside Files");
  return c;
}

export function Files({ initialPlaces }: { initialPlaces: Places | null }) {
  const fmt = useFormat();
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const params = useSearchParams();
  const screen: Screen = params.get("view") === "trash" ? "trash" : params.get("path") ? "browse" : "front";
  const path = screen === "browse" ? params.get("path") : null;
  const places = useApi<Places>("/api/files/places", { fallbackData: initialPlaces ?? undefined, refresh: 60_000 });
  const trash = useApi<TrashSummary>(screen === "trash" ? "/api/files/trash" : null);

  // ?select=name lands on that item once the folder is listed (also when a link arrives while Files is open).
  const [reveal, setReveal] = React.useState<string | null>(null);
  const selectParam = params.get("select");
  React.useEffect(() => {
    if (path && selectParam) setReveal(joinPath(path, selectParam));
  }, [path, selectParam]);

  const go = React.useCallback((p: string | null, opts: { select?: string; replace?: boolean } = {}) => {
    const url = p ? filesHref(p) : "/files";
    if (opts.select && p) setReveal(joinPath(p, opts.select));
    if (opts.replace) window.history.replaceState(window.history.state, "", url);
    else {
      window.history.pushState(null, "", url);
      window.scrollTo({ top: 0 });
    }
  }, []);

  const refreshers = React.useRef(new Set<() => void>());
  const onRefresh = React.useCallback((fn: () => void) => {
    refreshers.current.add(fn);
    return () => void refreshers.current.delete(fn);
  }, []);
  const refresh = React.useCallback(() => {
    clearSearchCache();
    refreshers.current.forEach((f) => f());
    void places.mutate();
    void trash.mutate();
    // places.mutate and trash.mutate are stable SWR handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [here, setHere] = React.useState<ListingT | undefined>(undefined);
  const [hereError, setHereError] = React.useState<ApiError | null>(null);
  const [selection, setSelection] = React.useState<Selected>({ entries: [], dir: null, writable: false });
  React.useEffect(() => {
    if (screen !== "browse") {
      setHere(undefined);
      setSelection({ entries: [], dir: null, writable: false });
    }
  }, [screen]);

  const { actions, nodes } = useFileActions({ here, places: places.data, refresh });
  // ---- quick look: photos and video in the lightbox, everything else in the preview (which edits text)
  const [look, setLook] = React.useState<{ entry: FileEntry; siblings: (FileEntry | SearchHit)[] } | null>(null);
  const lookAt = React.useCallback((entry: FileEntry, siblings: (FileEntry | SearchHit)[] = []) => {
    if (isDirLike(entry)) return;
    setLook({ entry, siblings: siblings.filter((x) => x.type !== "dir" && !("mode" in x && isDirLike(x))) });
  }, []);
  const changeLook = React.useCallback((entry: FileEntry) => setLook((l) => (l ? { ...l, entry } : l)), []);
  const closeLook = React.useCallback(() => setLook(null), []);
  const lookHit = React.useCallback(
    (h: SearchHit, siblings: SearchHit[] = []) => {
      void statEntry(h.path).then(
        (e) => lookAt(e, siblings),
        (err: unknown) => toast.error(`Couldn't open ${h.name}`, { description: err instanceof Error ? err.message : "It may have been moved or deleted." }),
      );
    },
    [lookAt],
  );

  const browser = React.useRef<BrowserApi | null>(null);
  const [keys, setKeys] = React.useState(false);
  const showKeys = React.useCallback(() => setKeys(true), []);
  const mod = useModKey();
  const openTrash = React.useCallback(() => window.history.pushState(null, "", "/files?view=trash"), []);
  const doneReveal = React.useCallback(() => setReveal(null), []);

  // Memoised so typing in the bar or changing the selection doesn't re-render every column.
  const state: FilesState = React.useMemo(
    () => ({ admin, places: places.data, screen, path, go, openTrash, reveal, doneReveal, setSelection, setHere, setHereError, actions, look: lookAt, lookHit, refresh, onRefresh, browser, showKeys }),
    [admin, places.data, screen, path, go, openTrash, reveal, doneReveal, actions, lookAt, lookHit, refresh, onRefresh, showKeys],
  );
  const bar = React.useMemo(() => ({ here, selection }), [here, selection]);

  // Places couldn't be read at all (the server's down or the request failed): say so, with a retry.
  if (!places.data && places.error) {
    return (
      <Page narrow>
        <PageHeader title="Files" summary="Files can't be shown right now." />
        <Notice tone="fault" title={places.error.code === "network" ? "Can't reach the server" : "Couldn't load your folders"} action={<Button size="sm" onClick={() => void places.mutate()}>Try again</Button>}>
          {places.error.code === "network" ? "Check the connection, then try again." : places.error.message}
        </Notice>
      </Page>
    );
  }

  // A member nobody has shared a folder with has nothing to browse; say so plainly.
  if (!admin && places.data && !places.data.places.length && !places.data.pins.length) {
    return (
      <Page narrow>
        <PageHeader title="Files" summary="Nothing has been shared with you yet." />
        <Empty title="No folders shared with you yet">When an admin shares a folder with you, like the family photos or the film library, it shows up here and you can open, upload and download from any device.</Empty>
      </Page>
    );
  }

  let title: React.ReactNode = "Files";
  let summary: React.ReactNode = null;
  if (screen === "trash") {
    title = "Trash";
    const t = trash.data;
    summary = t ? (t.items.length ? `${fmt.plural(t.items.length, "item")} using ${fmt.bytes(t.byFilesystem.reduce((a, f) => a + f.bytes, 0))}. Deleted things stay here until ${admin ? "you empty the trash" : "an admin empties the trash"}.` : "Nothing in the trash.") : <Skeleton width={260} height={12} />;
  } else if (screen === "browse") {
    title = <span className={s.title} title={here?.path ?? path ?? ""}>{folderTitle(here?.path === path ? here : undefined, path ?? "/", places.data)}</span>;
    summary = here && here.path === path ? folderSentence(here, places.data, fmt, admin) : hereError ? (hereError.code === "network" ? "Can't reach the server right now." : "This folder can't be shown.") : <Skeleton width={260} height={12} />;
  }

  const lightbox = look && inLightbox(look.entry);
  return (
    <Ctx.Provider value={state}>
      <BarCtx.Provider value={bar}>
        <Page>
          <PageHeader
            title={title}
            summary={screen === "front" ? <FrontSummary places={places.data} /> : summary}
            actions={
              screen === "trash" ? (
                <Button variant="ghost" icon={<NavArrowLeft />} onClick={() => go(null)}>
                  Back to files
                </Button>
              ) : undefined
            }
          />
          <CommandBar />
          {screen === "front" ? <Front /> : screen === "trash" ? <TrashView data={trash.data} error={trash.error} isAdmin={admin} refresh={() => void trash.mutate()} onJob={actions.upsertJob} onNavigate={(p) => go(p)} /> : <Browser />}
        </Page>
        {look && lightbox && <Lightbox entry={look.entry} siblings={look.siblings} onChange={changeLook} onClose={closeLook} />}
        <Preview
          entry={look && !lightbox ? look.entry : null}
          siblings={(look?.siblings ?? []).filter((x): x is FileEntry => "mode" in x)}
          onNavigate={changeLook}
          onClose={closeLook}
          canWrite={!!look && (selection.writable || (here?.access === "write" && !here.protectedReason && parentOf(look.entry.path) === here.path))}
          onExtract={(e) => void actions.extract(e)}
          onSaved={refresh}
        />
        <Shortcuts open={keys} onClose={() => setKeys(false)} mod={mod} />
        {nodes}
      </BarCtx.Provider>
    </Ctx.Provider>
  );
}

function FrontSummary({ places }: { places: Places | undefined }) {
  const fmt = useFormat();
  if (!places) return <Skeleton width={300} height={12} />;
  const drives = places.places.filter((d) => d.kind === "drive" && d.fs);
  if (!places.admin) {
    const shares = places.places.filter((p) => p.kind === "grant");
    return <>{shares.length ? `${fmt.plural(shares.length, "folder")} shared with you.` : "Your pinned folders."}</>;
  }
  const free = drives.reduce((a, d) => a + (d.fs?.avail ?? 0), 0);
  return <span className="num">{drives.length ? `${fmt.bytes(free)} free across ${fmt.plural(drives.length, "drive")}.` : "Every folder on the server."}</span>;
}
